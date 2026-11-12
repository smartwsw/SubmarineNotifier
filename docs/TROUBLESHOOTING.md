# TROUBLESHOOTING — 排障手册

> 按「现象 → 可能原因 → 验证方法 → 处理」组织。先看你遇到的现象。

---

## A. 插件侧

### A1. 聊天框提示「等待登录」，状态页没有潜水艇

**原因**：插件已加载但尚未检测到登录，或 `IClientState.IsLoggedIn` 为 false。

**验证**：
- 是否在角色选择界面？进入游戏世界后再看。
- 用 `/subnotify scan` 手动触发一次。

**处理**：正常登录后插件会自动扫描。若已进入游戏仍是该状态，检查 Dalamud 是否在游戏中正常加载（`/xldev`）。

---

### A2. 提示「工坊数据未加载」

**原因**：`HousingManager.Instance()->WorkshopTerritory` 为空。客户端必须**曾经加载过工坊数据**（打开过 FC 工坊的潜水艇面板）才会填充。

**这是设计上的已知限制**，不是 bug。插件不会猜测、不会上传空数据，只保留上一次缓存。

**处理**：
1. 前往 FC 房屋，进入工坊，打开潜水艇面板一次（不需要做任何操作）。
2. 回到 `/subnotify` 点「手动刷新」。
3. 表格应出现潜水艇。

**补充**：如果从来不进工坊，云端不会有记录，也就不会收到通知。这属于预期行为。

---

### A3. 状态页显示的是旧数据（名称/时间对不上）

**原因**：当前扫描未就绪（A2），界面回退显示 `LastScan` 缓存，标题会提示「工坊数据未加载」。

**处理**：进一次工坊面板后刷新。已上传到云端的返航时间不受影响。

> **换电脑后特别注意**：游戏只在客户端加载过工坊数据后才提供潜艇信息。
> 在设备 B 登录却没有打开工坊时，插件读不到任何数据 —— 它**不会**上传空列表（那会把云端记录当成"全部删除"），
> 只显示本机缓存并提示。云端保留设备 A 上报的较新记录，通知照常触发。
> 想在本机看到最新状态，进一次工坊→潜水艇面板即可，之后两台设备的数据会自动合并。

---

### A4. 「最近一次失败」显示 `NETWORK_ERROR` / `TIMEOUT`

**原因**：插件连不上 Worker（DNS、网络、Worker 未部署、地址写错）。

**验证**：
1. 「绑定」页点「连接测试」。
2. 在电脑浏览器打开 `https://<你的地址>/api/v1/health`，应返回 `{"ok":true,...}`。

**处理**：
- 地址必须以 `https://` 开头（插件会自动补全，但填错主机名无法修复）。
- 公司网络/代理可能拦截 `workers.dev`；试试手机热点。
- 确认 Worker 已部署：`npx wrangler deployments list`。

插件按 5s → 10s → 20s …（上限 10 分钟，±20% 抖动）自动重试，恢复后会自动补传，无需手动操作。

---

### A5. 提示 `NOT_AUTHENTICATED` / `INVALID_TOKEN` / `TOKEN_REVOKED`

**原因**：插件配置里的 token 失效（被轮换/撤销）或从未绑定。

**处理**：
- 从未注册 → 「绑定」页点「注册新设备」。
- token 失效 → 同样重新注册（会得到新用户；旧的云端数据不会自动迁移）。
- 若是自己误操作 `POST /auth/rotate`，旧 token 已失效，只能重新注册。

---

### A6. 「注册新设备」失败：`RATE_LIMITED`

**原因**：注册接口按 IP 限流，**5 次/小时**。

**处理**：等一小时，或换网络（不同出口 IP）。本地联调时可清空本地限流表：

```bash
cd cloud
npx wrangler d1 execute submarine-notifier --local --command "DELETE FROM rate_limits;"
```

---

### A7. 提示「地址无效」

**原因**：`CloudClient.NormalizeBase` 只接受 `http` / `https`，或字符串无法解析成 URI。

**处理**：填 `submarine-notifier.xxx.workers.dev`（自动补 https）或完整的 `https://...`。不要带路径（`/api/v1` 会被忽略并截断到路径根）。

---

### A8. 上传一直「有待上传的变化」，但状态页没报错

**原因**：内容确实在变化（比如剩余时间戳变化被当作返航时间变化），或扫描节流导致记录未更新。

**验证**：开启「诊断 → 输出调试日志」，看 Dalamud 日志中的 `ChangeDetector` 输出。

**说明**：插件只在 `returnAt / name / rank / routePoints` 变化时判定为变化。返航时间不变时，同样的内容不会重复上传（本地哈希去重 + 云端 7 天哈希去重双重保护）。

---

### A3b. 提示「云端已有更新的数据，本次上报未覆盖」

**原因**：这是**保护**，不是故障。同一账号在两台设备（或两个地点）同时登录时，其中一台读到的是过时快照；云端已经存有采集时刻更新的数据，于是拒绝用旧数据覆盖，并让这次通知照旧发出。

**验证**：看状态页「最近一次失败」或 `/submarines/sync` 的响应：

- `stale: true`、`accepted: 0`
- `warnings` 中有一条 `stale_snapshot: dropped, stored snapshot is newer (...)`

**处理**：进一次工坊让插件重新读取最新数据即可，下一次上报的采集时刻会更新，正常覆盖。云端已排定的通知不会因为这次上报被取消。

> 被软删除的槽位（本次上报里消失、或被手动删除）也会记下"看到它不存在的时刻"，所以旧设备拿旧快照回来**不会让已删除的潜水艇复活**。这一层同样由云端处理，插件无需干预。

**补充**：新旧比较依赖插件的 `collectedAt`。插件每次上传成功都会用响应里的 `serverTime` 校准本机时钟偏差，所以本机时钟不准不会导致自己的新数据被误判成旧数据。只有从未校准过（全新安装）且时钟偏差极大时才可能触发一次误判。

---

### A9. 插件列表里看不到本插件 / Dalamud 日志报 API Level 不匹配

**原因**：插件清单的 `DalamudApiLevel` 与本机 XIVLauncher 安装的 Dalamud API Level 不一致。本项目清单为 **15**，用 API 11 的 Dalamud 加载会被拒绝，反之亦然。

**验证**：打开 `%APPDATA%\XIVLauncher\addon\Hooks\dev\Dalamud.dll` 的文件版本，或看 `%APPDATA%\XIVLauncher\launcherConfigV3.json` / Dalamud 日志中的 API Level；再对照 `plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.json` 里的 `DalamudApiLevel`。

**处理**：
- 本机 Dalamud 是 API 15 → 直接用当前构建产物。
- 本机 Dalamud 是其它 API Level → 需要改 SDK 版本、清单字段与少量 API 调用（API 11 与 15 的差异见 [RESEARCH.md §6.4](RESEARCH.md)），重新构建；不能只改清单数字，否则会因 `IPlayerState`、`Dalamud.Bindings.ImGui` 等差异编译或运行时失败。

---

## B. 推送侧

### B1. 「保存并测试」失败：`PUSH_FAILED`

**原因**：云端成功调用了 Bark，但 Bark 返回错误。

**验证**：看返回的 message（形如 `HTTP 400: {"code":400,"message":"failed to get device token"}`）。

**常见对应**：

| message 片段 | 原因 | 处理 |
|---|---|---|
| `failed to get device token` | Device Key 错误或不存在 | 重新从 Bark App 复制 |
| `HTTP 404` | Server URL 路径错 | 只填域名，例如 `https://api.day.app`，不要带 `/push` |
| `HTTP 401/403` | 自建 Bark Server 需要认证 | 检查自建服务配置 |
| `HTTP 5xx` | Bark 服务端故障 | 稍后重试 |
| 超时 / `network error` | 云端到 Bark 网络不通 | 换 Server URL，或自建服务 |

---

### B2. 「保存并测试」返回 `INVALID_PUSH_URL`

**原因**：设置了 `http://` 地址，但环境是 production。

**说明**：生产环境只允许 https。`http` 仅在 `ENVIRONMENT=dev` 且主机在 `DEV_INSECURE_PUSH_HOSTS` 白名单内才允许（本地联调用）。

**处理**：改用 `https://` 地址，或自建 Bark Server 时配置 TLS。

---

### B3. 「保存并测试」返回 `PROVIDER_NOT_CONFIGURED`

**原因**：provider 是 `none`，或未保存 Device Key。

**处理**：确认「推送方式」不是「不推送」，且已填写 Key 再保存。

---

### B4. 测试推送能收到，但返航时间到了没有通知

按顺序排查：

1. **云端是否有该用户的数据？**
   ```bash
   curl https://<worker>/api/v1/status -H "authorization: Bearer <token>"
   ```
   看 `submarines.total` 与 `scheduler.pendingBatches`、`scheduler.nextAlarmAt`。

2. **`pendingBatches=0` 且 `nextAlarmAt=null`？**
   说明没有待发事件。检查潜水艇的 `returnAt` 是否为 0（未出航）或已经发过（`notification_logs` 里有记录）。

3. **`notifications` 里有 `failed` 记录？**
   ```bash
   curl https://<worker>/api/v1/notifications?limit=10 -H "authorization: Bearer <token>"
   ```
   有 `failed` 说明发送失败且已用尽重试（5 次，约 25 分钟跨度）。看 `error` 字段定位。

4. **`providerConfigured=false`？**
   说明 Key 未保存成功，重新在插件里保存。

5. **`notificationEnabled=false`？**
   通知被关闭了。

---

### B5. 通知重复发送

**理论上不应发生**：`notification_logs.event_key` 对 `ret:{submarineId}:{returnAt}` 有唯一约束，提前通知对 `adv:{userId}:{notifyAt}` 有唯一约束。

**可能的真实原因**：
- **潜水艇返航时间真的变了两次**（例如重新出航后又上传了新时间）→ 这是两个不同事件，发两条是正确的。
- 手动在插件里反复「手动上传」：不会导致重复（云端有哈希去重 + 事件唯一键）。
- 点过「立即发送下次返航」：那是有意多发的预览，正式通知仍会照常再发一条。
  日志里可以用 `event_type = next` 区分，它不占用 `ret:` 幂等键。

**验证**：
```bash
curl "https://<worker>/api/v1/logs?limit=50" -H "authorization: Bearer <token>"
```
检查 `eventKey` 是否真的不同。若相同 eventKey 出现两条 `sent`，属于严重 bug，请保留日志并反馈。

---

### B6. 通知时间差 8 小时

**原因**：云端时区默认 `UTC`，插件没有设置时区。

**处理**：`/subnotify` → 推送页 → 时区填 `Asia/Shanghai` → 保存。

**注意**：时区只影响**文案里的时间显示**，不影响触发时刻（触发用的是绝对 Unix 秒）。

插件会在保存时校验时区：无法识别的 IANA 名称会显示橙色警告，云端也会返回 400 `VALIDATION_ERROR`。

---

### B7. Bark 收到了，但完全没有声音 / 被静音

**原因**：iOS 通知权限或专注模式；或 Bark 的 `level` 参数。

**处理**：
- 检查 iOS 设置 → 通知 → Bark 权限与声音。
- 检查是否开启专注模式。
- 云端默认不传 `level`，Bark 使用默认级别；如需强提醒可在云端设置 `notifyPriority`（Bark 映射 `critical/active/timeSensitive/passive`）。

---

## C. 云端侧

### C0. Wrangler 报 `Invalid property: databaseId => Invalid uuid [code: 7400]`

**原因**：`cloud/wrangler.toml` 的 `database_id` 还是占位符 `REPLACE_WITH_D1_DATABASE_ID`。执行 `--remote` 命令时 Wrangler 把它当 UUID 发给 Cloudflare API。

**验证**：`npx wrangler d1 list` 能看到账号下真实存在的数据库与 UUID。

**处理**：把真实 UUID 填进 `wrangler.toml` 的 `[[d1_databases]]` 段落后重试。若列表为空，先按 [DEPLOYMENT.md §1](DEPLOYMENT.md) 创建。

---

### C0b. 部署失败：`You need a workers.dev subdomain in order to proceed [code: 10063]`

**原因**：该 Cloudflare 账号从未创建过 workers.dev 子域（新账号首次部署的典型状况）。这不是代码或配置问题。

**处理**：去 Dashboard 打开一次 Workers & Pages 页面会自动生成；或用 API 指定：

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain" \
  -H "Authorization: Bearer <API_TOKEN>" -H 'content-type: application/json' \
  -d '{"subdomain":"your-unique-prefix"}'
```

之后重新 `npx wrangler deploy`。

---

### C0c. 部署成功但本机访问返回 `connection reset` / `Couldn't connect`

**原因**：本机 DNS 被污染，`*.workers.dev` 解析到了无关 IP；或到 Cloudflare 边缘的 443 连接被干扰。Worker 本身是正常的。

**验证**：用 DoH 查真实 IP，与 `nslookup` 结果对比：

```bash
curl -s 'https://cloudflare-dns.com/dns-query?name=<host>.workers.dev&type=A' -H 'accept: application/dns-json'
```

若 DoH 返回 `104.x` / `172.67.x`，而本机解析是 `31.13.x` 之类，即为 DNS 污染。

**处理**：临时用 `--resolve` 绕开验证（80 端口通常可用）：

```bash
curl -s --resolve "<host>.workers.dev:80:<真实IP>" "http://<host>.workers.dev/api/v1/health"
```

长期方案：绑定自定义域名，或改用可用网络环境。

---

### C1. 部署失败：`Durable Objects are not available on your plan`

**原因**：当前 Cloudflare 套餐不支持 SQLite 后端 DO。

**处理**：升级到 Workers Paid，或参考官方文档确认当前免费计划对 SQLite DO 的支持情况：<https://developers.cloudflare.com/durable-objects/platform/pricing/>。

---

### C2. 部署后所有接口都返回 `MISCONFIGURED`

**原因**：`SECRETS_KEY` 未设置，或不是 32 字节的 base64。

**验证**：
```bash
cd cloud
npx wrangler secret list          # 应包含 SECRETS_KEY
echo -n '<你的密钥>' | base64 -d | wc -c   # 必须输出 32
```

**处理**：
```bash
openssl rand -base64 32
npx wrangler secret put SECRETS_KEY
```

---

### C3. 接口返回 500 `INTERNAL_ERROR`

**原因**：Worker 内部异常（常见：迁移未执行，表不存在）。

**验证**：
1. `npx wrangler tail` 看 `console.error` 中的 message。
2. 确认迁移已应用：`npx wrangler d1 migrations apply submarine-notifier --remote`。

**说明**：500 响应体只包含 `INTERNAL_ERROR`，不含堆栈（有意为之，避免信息泄露）。

---

### C4. 所有请求返回 429 `RATE_LIMITED`

**原因**：触发了限流。

| 范围 | 限制 |
|---|---|
| `POST /submarines/sync` | 60 次/分钟/用户 |
| `POST /push/test` | 10 次/分钟/用户 |
| `POST /push/next` | 10 次/分钟/用户 |
| `POST /auth/register` | 5 次/小时/IP |

**处理**：等窗口过去（响应带 `Retry-After`）。本地可用 `DELETE FROM rate_limits;` 清空。

**注意**：正常使用下插件不会接近 sync 限流——内容不变时它根本不发请求。

---

### C5. 关掉游戏后没有收到通知，云端也没有待处理批次

**排查**：
1. 关游戏**之前**潜水艇是否已成功上传？（插件状态页「上次成功上传」）
2. `pendingBatches` 是否为 0？（说明没有 future 的返航事件）
3. 返航时间是否已经过去？过去的任务会在下一次 alarm 立即处理，随后清空。

**最常见原因**：玩家长时间不进工坊，插件读不到新数据；已在云端的事件不受影响，但**新的**返航时间从未上传过。

---

### C6. Durable Object 状态和 D1 不一致

DO 只存 `userId`、`lastAlarmAt`、`lastRunResult`、`lastCleanup`。排程的唯一事实来源是 D1 的 `notification_batches`。

**恢复方法**（任意一条即可让 DO 重新计算）：

```bash
curl -X POST https://<worker>/api/v1/submarines/refresh -H "authorization: Bearer <token>"
```

或直接触发一次 sync。

---

## D. 开发与测试

### D0. `npm test` 报 `node:util does not provide an export named 'styleText'`

**原因**：Node 版本过低（18.x）。Vitest 4 的打包器 rolldown 在启动时 `import { styleText } from "node:util"`，该导出在 Node 18 不存在，于是在加载阶段就抛 `SyntaxError`，看起来像代码问题，其实与项目源码无关。

注意 `npm test` 用的是 PATH 里的 `node`，不是 `npm` 自己——即使 `npm -v` 显示 10.x，只要 `node -v` 是 18 就会报这个错。

**验证**：

```bash
node -v          # 需要 v22.12.0 或更高
node -e "console.log(typeof require('node:util').styleText)"   # Node 22 输出 function，Node 18 输出 undefined
```

**处理**：换用 Node 22.12+。本仓库自带便携版 Node 22（不需要安装、不污染系统），把它的目录放到 PATH 最前面即可：

```bash
export PATH="/g/SubmarineNotifier/.tooling/node/node-v22.20.0-win-x64:$PATH"
node -v          # v22.20.0
npm test
```

`cloud/package.json` 已声明 `"engines": { "node": ">=22.12.0" }`，所以在 Node 18 上执行 `npm install` 会先打印 `npm warn EBADENGINE ... required: { node: '>=22.12.0' } current: { node: 'v18.20.3' }`——看到这条警告就说明用错了 Node。

在同一个 shell 里跑 `wrangler dev` 与联调脚本时也要带上这个 PATH，否则 `npx wrangler` 仍会用系统 Node 18。

---

### D1. `dotnet build` 找不到 .NET SDK / SDK 版本不够

不同工程需要的 SDK 不同：

| 工程 | 目标框架 | 需要的 SDK |
|---|---|---|
| `SubmarineReturnNotifier.Core`、`SubmarineReturnNotifier.Tests` | `net8.0` | 任意 .NET 8+ |
| `SubmarineReturnNotifier`（插件本体） | `net10.0-windows` | **.NET 10 SDK** |

插件工程的目标框架由 `Dalamud.NET.Sdk/15.0.0` 提供，用 .NET 8 SDK 构建会报 `NETSDK1045: 当前 .NET SDK 不支持面向 .NET 10.0 的目标框架`。

**处理**：
- 只跑单测：用 `.tooling/dotnet/dotnet.exe`（8.0.404）。
- 构建插件：安装 .NET 10 SDK，并让 `DALAMUD_HOME` 指向 API 15 的 Dalamud 程序集目录。

```bash
export DALAMUD_HOME=/path/to/dalamud-api15     # 含 Dalamud.dll、Dalamud.Bindings.ImGui.dll 等
dotnet --version                              # 需 10.0.x
dotnet build plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.csproj -c Release
```

**验证**：构建输出的第一行会打印 `Dalamud.NET.Sdk: root at <DALAMUD_HOME>/`，随后应看到 `Build succeeded. 0 Warning(s) 0 Error(s)`。

---

### D2. NuGet 还原失败

默认源 `api.nuget.org` 在某些网络下返回 302。仓库使用镜像 `https://nuget.azure.cn/v3/index.json`。检查 `NuGet.config` 是否被覆盖。

---

### D3. `wrangler dev` 起不来 / 端口占用

```bash
netstat -ano | findstr :8787
# 用任务管理器或 PowerShell 结束对应 node/workerd 进程
taskkill /PID <pid> /F
```

---

### D4. Git Bash 下 `/tmp/xxx` 被解析成 `G:\tmp\xxx`

**原因**：Git Bash 的路径转换把以 `/` 开头的参数交给了 Windows 程序，`.tooling` 下的脚本收到的可能就是 `G:\tmp\...`，目录不存在时报 `ENOENT`。

**处理**：给脚本传显式路径参数（`PHASE5_ARTIFACT=...`、`PHASE5_ACCOUNT=...`），或使用 `$(pwd)/tmp/...` 这类绝对路径。

---

### D5. 本地联调测试注册返回 429

本地限流表跨测试累积。清空：

```bash
cd cloud
npx wrangler d1 execute submarine-notifier --local --command "DELETE FROM rate_limits;"
```

联调脚本 `.tooling/delivery/run.mjs` 会把账号保存在 `.tooling/delivery/account.json` 以便重复执行时复用。

---

### D6. Vitest 偶发 `runDurableObjectAlarm` 返回 false

已修复：alarm 被安排在 `now+1` 秒，慢机器上可能先于手动触发自行执行。测试现在接受两种时序，并断言「不重复推送」。

若仍偶发失败，检查是否有其他测试共享同一个 DO 实例（每个用例使用独立用户 → 独立 DO）。

---

## E. 数据与隐私

### E1. 云端能看到我的 Bark Key 吗？

不能（通过 API）。Key 以 AES-256-GCM 加密存储，密钥是 Worker secret；API 只返回 `••••••••` 与 `providerConfigured`。运维者有 `SECRETS_KEY` 时可以解密，所以**自建服务时请自己保管好密钥**。

### E2. 日志里会不会出现 token？

- 插件日志全部经过 `Redaction.Apply`：`srk_...` → `srk_***`，URL 中的 key 段 → `***`。
- 云端只在 500 时记录 `requestId` / `path` / 异常 message，不记录请求体。

自动化测试 `LoggerRedactionTests` 与联调检查 `日志不含完整 token` 覆盖这一点。

### E3. 如何彻底删除我的数据？

插件「绑定」页 →「删除云端账号」（点两次确认）。等价于：

```bash
curl -X DELETE https://<worker>/api/v1/account \
  -H "authorization: Bearer <token>" \
  -H 'content-type: application/json' \
  -d '{"confirm":"DELETE"}'
```

级联删除该用户的所有表记录，并清理 DO alarm。
