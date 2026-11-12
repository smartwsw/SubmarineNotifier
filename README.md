# Submarine Return Notifier — FF14 潜水艇返航通知

一个自托管方案：**在线时**由 Dalamud 插件读取 FC 工坊中的潜水艇返航时间并增量上传到 Cloudflare；**下线或关电脑后**由云端按绝对时间调度，把合并后的返航提醒推送到手机（Bark / ntfy）。

> 插件只做采集与上报，不发通知；通知完全由云端 Scheduler（Durable Object Alarm）驱动，因此关掉游戏、关掉电脑都不影响推送。

---

## 1. 它解决什么问题

FF14 的潜水艇返航时间只在客户端里可见，玩家不登录就看不到。常见做法是常驻一个程序定时检查，但这要求电脑一直开着。

本项目把「什么时候返航」这件事一次性同步到云端：

- 插件在能读到工坊数据时，把**绝对 Unix 返航时间**上传一次；
- 云端把它持久化到 D1，并用 Durable Object 的 **alarm** 安排通知；
- 到点后云端直接调用 Bark / ntfy 推送，与客户端是否在线无关。

---

## 2. 系统架构

```
┌──────────────────────────────┐        HTTPS + Bearer token        ┌────────────────────────────────┐
│ Dalamud 插件 (C#, API 15)    │ ─────────────────────────────────► │ Cloudflare Worker (TypeScript) │
│                              │                                    │                                │
│ SubmarineProvider            │                                    │  routes/  auth / submarine /   │
│  └ HousingManager → 工坊数据 │                                    │           settings / push      │
│ SubmarineScanner             │                                    │  services/ 合并、投递、调度    │
│  └ 变化检测 / 节流           │                                    │  storage/  D1 Repository       │
│ CloudUploader                │                                    │                                │
│  └ 待上传队列 / 指数退避     │                                    │  Durable Object: Scheduler     │
│ LocalCache (JSON，原子写)    │                                    │   └ alarm 驱动的通知排程       │
└──────────────────────────────┘                                    └───────────────┬────────────────┘
                                                                                    │ HTTPS
                                                                                    ▼
                                                                          Bark / ntfy（手机）
```

**职责边界**

| 层 | 负责 | 不负责 |
|---|---|---|
| 插件 | 读取工坊数据、变化检测、增量上传、本地缓存、配置 UI | 不发通知、不做云端调度、不依赖 AutoRetainer |
| 云端 | 持久化返航事件、合并批次、提前/正式通知、幂等、失败重试、用户隔离 | 不依赖游戏在线状态 |
| 推送 | Bark / ntfy HTTP API | 不存任何用户凭据明文 |

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DATABASE.md](docs/DATABASE.md)、[docs/SECURITY.md](docs/SECURITY.md)、[docs/API.md](docs/API.md)。

---

## 3. 仓库结构

```text
cloud/                                  Cloudflare Worker（TypeScript + Wrangler + Vitest）
  migrations/0001_initial.sql           D1 表结构与索引
  src/index.ts                          路由入口
  src/routes/                           auth / submarine / settings / push / account
  src/services/                         合并、投递、调度、push provider
  src/durable-objects/scheduler.ts      每用户一个 Scheduler DO（仅用 setAlarm）
  src/storage/repository.ts             全部 SQL（参数化）
  tests/                                76 个 Vitest 用例

plugin/SubmarineReturnNotifier/         Dalamud 插件（net10.0-windows，API 15）
  Plugin.cs                             生命周期、命令、后台上传
  Configuration.cs                      IPluginConfiguration
  ConfigurationWindow.cs                状态 / 绑定 / 推送 / 诊断 四个标签页
  Submarine/                            工坊读取、扫描、节流
  SubmarineReturnNotifier.json          插件清单

plugin/SubmarineReturnNotifier.Core/    与 Dalamud 无关的核心逻辑（net8.0，可单测）
plugin/SubmarineReturnNotifier.Tests/   xunit 单测（111 个）

docs/                                   RESEARCH / ARCHITECTURE / DATABASE / API /
                                        SECURITY / DEPLOYMENT / TROUBLESHOOTING / USER_GUIDE
```

把逻辑放进 `.Core` 是刻意的：调度、重试、去重、载荷构建、缓存持久化、HTTP 错误映射、通知文案、日志脱敏全部可在没有游戏的环境下被自动化测试覆盖；插件工程只保留不能单测的部分（unsafe 读取、ImGui 界面）。

---

## 4. 快速开始

三步：**部署云端 → 装插件 → 绑定并配置 Bark**。

### 4.1 部署云端

需要 Node.js 22.12+（Wrangler 4 的要求）与 Cloudflare 账号（Wrangler 会用 `wrangler login` 授权）。

```bash
cd cloud
npm install

# 1) 创建 D1，把输出的 database_id 填入 wrangler.toml
npx wrangler d1 create submarine-notifier

# 2) 设置加密密钥（32 字节 base64，用于加密 Bark Key）
openssl rand -base64 32
npx wrangler secret put SECRETS_KEY

# 3) 应用数据库迁移
npx wrangler d1 migrations apply submarine-notifier --remote

# 4) 部署
npx wrangler deploy
```

部署完成后会得到 `https://submarine-notifier.<你的子域>.workers.dev`。验证：

```bash
curl https://submarine-notifier.<你的子域>.workers.dev/api/v1/health
# {"ok":true,"data":{"status":"ok","serverTime":...}}
```

两个首次部署常见卡点（详见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)）：

- `Invalid uuid [code: 7400]`：`wrangler.toml` 里的 `database_id` 还是占位符，用 `npx wrangler d1 list` 查真实值填进去。
- `You need a workers.dev subdomain [code: 10063]`：账号还没有 workers.dev 子域，打开一次 Dashboard 的 Workers 页面即可生成。

完整的逐步骤说明、迁移与回滚见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

### 4.2 安装插件

#### 方式 A：从插件仓库安装（有仓库地址时，推荐）

1. `/xlsettings` → **实验性 / Experimental** → **自定义插件仓库 / Custom Plugin Repositories**；
2. 粘贴仓库地址（以 `pluginmaster.json` 结尾），点 `+` 保存；
3. `/xlplugins` → 「全部 / All」→ 搜索 *Submarine Return Notifier* → 安装。

之后插件会自动提示更新。

#### 方式 B：本地目录安装（自己构建或没有仓库地址时）

1. 构建 Release 包（需要 **.NET 10 SDK** 与 **API 15 的 Dalamud 程序集**）：

   ```bash
   dotnet build plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.csproj -c Release
   ```

   产物：`plugin/SubmarineReturnNotifier/bin/Release/SubmarineReturnNotifier/latest.zip`。

   如果本机 XIVLauncher 安装的不是 API 15，用 `DALAMUD_HOME` 指向正确的程序集目录再构建：

   ```bash
   DALAMUD_HOME=/path/to/dalamud-api15 dotnet build plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.csproj -c Release
   ```

2. 解压到 Dalamud 的开发插件目录：`%APPDATA%\XIVLauncher\devPlugins\SubmarineReturnNotifier\`。
   目录内应有 `SubmarineReturnNotifier.dll`、`SubmarineReturnNotifier.Core.dll`、`SubmarineReturnNotifier.json` 与 `.deps.json`。

3. 在游戏内 `/xlplugins` → 开发插件列表启用 *Submarine Return Notifier*，或重启游戏后由 Dalamud 加载。

4. 游戏内输入 `/subnotify` 打开设置窗口。

> 插件清单 `DalamudApiLevel` 为 **15**，必须与 XIVLauncher 实际安装的 Dalamud API Level 一致，否则 Dalamud 会拒绝加载。游戏大版本更新后需等待 Dalamud / FFXIVClientStructs 同步升级，并重新编译。

**维护者发布成插件仓库**（打包、`pluginmaster.json`、托管与发版流程）见 [docs/RELEASE.md](docs/RELEASE.md)：

```bash
node .tooling/release/build-repo.mjs \
  --base-url https://raw.githubusercontent.com/<你>/SubmarineNotifier/main/dist/repo \
  --version 1.0.1.0

node .tooling/release/verify-repo.mjs --base-url http://127.0.0.1:8901 --zip-base http://127.0.0.1:8901
```

### 4.3 绑定与配置

打开 `/subnotify`：

1. **绑定** 页：填入 Worker 地址（`https://...workers.dev`），点「注册新设备」。
   - 云端返回的 token 只在此刻下发一次，插件已自动写入本地配置；云端只保存其 SHA-256 哈希，无法找回，丢失需重新注册。
2. **推送** 页：选择 Bark，填写 Device Key，点「保存并测试」。
   - Device Key 只发往云端加密保存，插件与 API 都不会再回传明文。
   - 记得把 **时区** 设为 `Asia/Shanghai`（默认是 UTC），否则通知里的时间会按 UTC 显示。
3. **状态** 页：进入过 FC 工坊后点「手动刷新」，确认能看到 4 个槽位的潜水艇与返航时间。

Bark 配置细节见 [§6](#6-bark-配置)。

---

## 5. 返航通知机制

### 5.1 数据来源

插件读取 `HousingManager.Instance()->WorkshopTerritory->Submersible`（FFXIVClientStructs，Dalamud 内置）。其中 `ReturnTime` 是服务器同步好的**绝对 Unix 秒**，`0` 表示未出航。

**不依赖 AutoRetainer**、不引用其程序集/IPC、不做任何内存修改；字段可用性已在 [docs/RESEARCH.md](docs/RESEARCH.md) 中用反射逐项核对。

### 5.2 合并（锚点 + 非链式）

云端把「尚未通知过」的返航事件按时间排序：

- 取最早未消费事件作为 anchor；
- 后续事件满足 `returnAt - anchor <= mergeWindow` 即并入同一批次（闭区间）；
- 超出窗口就以该事件为新 anchor；
- 批次通知时间 = 批次内**最晚**的返航时间。

比较基准始终是 anchor，不会出现"A 并 B、B 并 C、于是 A 和 C 也合并"的链式膨胀。合并窗口默认 10 分钟，可在插件内调 0–120。

例：返航 20:00 / 20:05 / 20:25，窗口 10 分钟 → 前两艘合成一条（20:05 推送），第三艘单独一条（20:25 推送）。

### 5.3 提前通知

可选提前 0 / 1 / 5 / 10 / 15 / 30 分钟发送，标题自动加「（即将返航）」。默认 5 分钟，设为 0 即关闭。

### 5.4 幂等与重试

- 每个「潜水艇 + 返航时间」事件在 `notification_logs.event_key` 上有唯一约束，重复 alarm、并发执行、配置变更重算都不会重复推送。
- 提前通知按 `(用户, 通知时刻)` 去重，批次重算后同一时刻不会重发。
- Bark 返回 5xx / 429 / 网络错误时按 60s → 120s → 240s → 480s → 960s 退避重试，最多 5 次；4xx（设备 Key 错）不重试，直接标记失败并保留错误信息。
- 同内容 sync 在云端按哈希去重 7 天，插件侧也会跳过与上次成功上传完全相同的载荷。
- 多设备场景下按采集时刻判新旧：旧快照被丢弃并返回 `stale: true`，不会覆盖数据、不会取消已排定的批次（详见 [API.md](docs/API.md#post-submarinessync)）。被软删除（本次上报里没出现，或被手动删除）的槽位也会写入"观察到它不存在"的采集时刻，因此**旧设备拿旧快照回来也无法把它复活**。

### 5.5 立即预览下一次返航通知

推送页的「立即发送下次返航」让云端把**下一次真实会发出的通知**立刻推一遍（`POST /push/next`）。
内容取自云端已排定的 pending 批次、按同样的模板和时区渲染，因此手机收到的就是正式通知的原文。

它**只读排程**：不写 `ret:`/`adv:` 幂等键、不改批次状态、不推进重试、不重算 alarm，
所以到点后正式通知仍会照常再发一条，预览不会导致漏发；日志里以 `event_type = next` 区分。

### 5.6 关闭游戏后

通知不经过插件。插件一旦上传过返航时间，云端就已把它写进 D1 并为该用户设置了 DO alarm。**关闭游戏、退出系统、Cloudflare 重启都不会取消已排定的 alarm**（alarm 状态持久化在 DO storage）。

---

## 6. Bark 配置

1. 在 iPhone 上安装 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865)。
2. 打开 App，复制首页显示的 Device Key（形如 `AbCdEfGhIjKlMn`）。
3. 插件「推送」页：推送方式选 **Bark**，
   - *Bark Server URL*：官方服务填 `https://api.day.app`；自建 Bark Server 填自己的地址。
   - *Bark Device Key*：粘贴上一步的 Key。
   - *通知分组*：可选，默认会写入 `FF14`。
4. 点「保存并测试」，手机应立刻收到一条测试通知。

云端发送的是 `POST {server}/push`：

```json
{
  "device_key": "AbCdEfGhIjKlMn",
  "title": "潜水艇返航",
  "body": "2 艘潜水艇已返航\n· 潜水艇A — 11/12 18:30\n· 潜水艇B — 11/12 18:30",
  "group": "FF14"
}
```

生产环境只接受 **https** 推送地址；`http` 仅在 `ENVIRONMENT=dev` 且主机在 `DEV_INSECURE_PUSH_HOSTS` 白名单内时放行（本地联调用）。

### 也可以使用 ntfy

推送方式选 **ntfy**，填写 Server URL（默认 `https://ntfy.sh`）、Topic；公开 Topic 建议同时配置 Access Token，否则任何人都能订阅到你的通知。

---

## 7. 用户注册方式

没有邮箱、没有密码，也不存在找回流程：

- 插件点「注册新设备」→ 云端创建 `userId` 与一个 token（`srk_` + 43 字符）；
- token 明文只在注册响应中出现一次，插件写入 Dalamud 配置；云端只存 `SHA-256(token)`；
- 同一用户可注册多台设备（`POST /auth/device`），设备间数据共享、token 相互独立。
  插件里用「绑定」页的 **加入已有账号**：在旧电脑点「复制 Token」，在新电脑粘贴后点「加入已有账号」，
  新设备就以独立 token 并入同一 `userId` —— 潜水艇数据、推送设置、通知历史立刻是同一份。
  「注册新设备」创建的是**全新账号**，只在第一次使用时点；
- 多设备（或同一账号在不同地点登录）会互相同步数据。云端按采集时刻判新旧：**旧快照不会覆盖新数据，也不会取消已排定的通知**；插件会提示「云端已有更新的数据，本次上报未覆盖」，进一次工坊重新读取即可；
- 「删除云端账号」按钮会级联删除该用户的所有潜水艇、设置、通知记录，并清理 DO 状态。

怀疑 token 泄露时可用 `POST /auth/rotate` 轮换（旧 token 立即失效）。

---

## 8. 费用与免费额度

本方案对 Cloudflare 的使用量很小：

| 资源 | 典型用量（1 个用户） | 说明 |
|---|---|---|
| Worker 请求 | 每天几次到几十次 | 只在潜水艇状态变化时上传；默认 60 秒轮询，但内容不变就不发请求 |
| D1 行读/写 | 每天几十到几百 | 每次 sync 几十行读写 |
| Durable Object | 每个通知时刻唤醒一次 | 提前通知 + 正式通知 = 每批次最多 2 次 alarm |
| 存储 | 每用户 < 100 KB | 潜水艇、设置、通知日志；日志 90 天后清理 |

免费额度的具体数值随 Cloudflare 政策变化，请以官方定价页为准：

- D1 定价与免费额度：<https://developers.cloudflare.com/d1/platform/pricing/>
- Durable Objects 定价（含免费计划对 SQLite 后端的支持情况）：<https://developers.cloudflare.com/durable-objects/platform/pricing/>

> 本项目使用的是 SQLite 后端的 Durable Object（`new_sqlite_classes`）。如果你的账号在当前套餐下无法创建 Durable Objects，需要升级到 Workers Paid 计划；这一点请以 Cloudflare 控制台的报错与官方文档为准。

---

## 9. 常见问题

**Q：我在游戏里看不到潜水艇数据？**
插件只能读到已加载的工坊数据。进一次 FC 工坊（或潜水艇面板）后再刷新即可；从没打开过工坊时云端不会有任何记录。

**Q：关闭游戏后还会收到通知吗？**
会。云端已持久化返航时间并设置 alarm，与客户端无关。前提是这条返航时间在关闭游戏前已经上传成功。

**Q：通知时间显示成 UTC / 差 8 小时？**
云端默认时区是 `UTC`。在插件「推送」页把时区设为 `Asia/Shanghai` 后保存即可。

**Q：为什么 Bark 的 Device Key 在界面上看不到了？**
插件按设计不回显它。云端加密存储且只返回 `••••••••`；需要更换时直接填入新 Key 保存，「留空表示不修改」。

**Q：重复点了「手动上传」会不会发两条通知？**
不会。云端对同一 `(潜水艇, 返航时间)` 事件有唯一键，重复上报被去重。

**Q：换角色 / 换账号会互相干扰吗？**
不会。云端所有查询都带 `user_id`，潜水艇以 `(character_id, slot_index)` 为稳定键；插件在登录/登出时重置扫描状态。

更多排障见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

---

## 10. 已知限制

1. **必须曾经加载过工坊数据**。`WorkshopTerritory` 为空时插件不上传、也不猜测，只保留上一次缓存。
2. **返航时间不会实时刷新**。它来自游戏客户端与服务器的同步；玩家不进工坊时，即使返航时间发生变化也不会被重新上传（但已上传的时间仍会照常触发通知）。
3. **换电脑登录后必须先打开一次工坊**。游戏只在客户端加载过工坊数据后才提供潜艇信息，
   因此设备 B 登录后若没打开工坊，它读不到任何数据 —— 插件此时**不上传空列表**（那会把云端记录删掉），
   只显示本机缓存并提示"工坊数据未加载"。云端则保留设备 A 上报的较新记录，通知照常触发；
   想在本机看到最新状态，进一次工坊→潜水艇面板即可。
4. **大版本更新需要等 Dalamud / FFXIVClientStructs 升级**。偏移由 FCS 维护，本项目不硬编码。
5. **系统时钟严重错误会影响展示**。上传的是绝对时间，但「剩余时间」和本机 `collectedAt` 依赖本机时钟。
6. **默认没有官方仓库**，需自建仓库（[RELEASE.md](docs/RELEASE.md)）或按 §4.2 方式 B 手动安装。
7. **同一 FFXIV 账号的多个角色**会共用同一个云端用户（共用设备 token），但数据按 `characterId` 分开存放。
8. **Bark 官方服务在中国大陆可能不稳定**，可自建 Bark Server 并在插件中填写自己的地址。

---

## 11. 开发与测试

```bash
# 云端：Node 必须是 22.12+（cloud/package.json 的 engines 已声明）。
# 本机若默认是 Node 18，先把仓库自带的便携版放到 PATH 最前面：
export PATH="/g/SubmarineNotifier/.tooling/node/node-v22.20.0-win-x64:$PATH"
node -v                    # 应为 v22.20.0

cd cloud
npm run typecheck          # tsc --noEmit
npm test                   # vitest（83 用例）
npm run dev                # 本地 wrangler dev
```

> Node 18 会在加载 rolldown 时就抛 `does not provide an export named 'styleText'`——这是 Node 版本问题，不是代码问题。注意 `npm test` 用的是 PATH 里的 `node`，`npm -v` 显示 10.x 也不代表 Node 够新。

# 插件
#   Core 与测试工程为 net8.0，任意 .NET 8+ SDK 即可
dotnet test plugin/SubmarineReturnNotifier.Tests/SubmarineReturnNotifier.Tests.csproj
#   插件工程为 net10.0-windows（Dalamud API 15 SDK 的要求），需要 .NET 10 SDK，
#   并让 DALAMUD_HOME 指向 API 15 的 Dalamud 程序集目录
DALAMUD_HOME=/path/to/dalamud-api15 dotnet build plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.csproj -c Release
```

端到端联调（需要本地 Worker 运行；同样要先把 Node 22 放到 PATH 最前面，否则 `npx wrangler` 会用系统 Node 18）：

```bash
# 1. 启动本地 Worker
cd cloud && npx wrangler dev --port 8787 --local

# 2. 插件 ↔ Worker 契约联调（注册/上传/去重/状态/设置/删号等 22 项检查）
dotnet run --project .tooling/integration/integration.csproj -- http://127.0.0.1:8787

# 3. 投递链路联调（合并 / 提前通知 / 正式通知 / Bark 失败重试，需配合假 Bark 服务）
node .tooling/fake-bark/server.mjs --port 8790 --out ./received.jsonl
node .tooling/delivery/run.mjs http://127.0.0.1:8787 http://127.0.0.1:8790

# 3b. 「立即发送下次返航」联调（真实批次内容 + 不影响排程，21 项检查）
node .tooling/delivery/push-next.mjs http://127.0.0.1:8787 http://127.0.0.1:8790

# 4. 校验插件预览与云端实际文案逐字一致
dotnet run --project .tooling/integration/integration.csproj -- verify-notification .tooling/delivery/cloud-notification.json
```

---

## 12. 许可与致谢

- 潜水艇数据结构来自 [FFXIVClientStructs](https://github.com/aers/FFXIVClientStructs)（Dalamud 官方内置），仅使用公开 API。
- 设计思路参考了 AutoRetainer 的公开源码，但本项目**不依赖、不引用、不反射**其任何实现。
- 推送依赖 [Bark](https://github.com/Finb/Bark) 与 [ntfy](https://ntfy.sh)。
