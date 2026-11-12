# RELEASE — 打包插件并发布成 Dalamud 插件仓库

> 面向**维护者**。普通玩家只需要拿到仓库地址，见 [USER_GUIDE.md](USER_GUIDE.md)。
>
> 目标：把插件发布成「第三方插件仓库」，玩家在 `/xlsettings` → 实验性 → 自定义插件仓库里粘贴一个 URL，
> 之后就能在 `/xlplugins` 里搜索、安装、自动更新 —— 不需要手动解压 zip。

---

## 0. 先理解 Dalamud 的更新机制

发布不是"传个 zip"这么简单，有三个必须遵守的约束：

| 约束 | 说明 |
|---|---|
| **文件名固定** | Dalamud 只请求 `<仓库地址>/pluginmaster.json`，名字不能改 |
| **内容是数组** | 整个文件必须是 JSON 数组，即使只有一个插件 |
| **版本靠 `AssemblyVersion`** | Dalamud 拿 `pluginmaster.json` 里的 `AssemblyVersion` 与已安装版本比较，**不比较** `LastUpdate`，也不看 zip 里的文件名 |
| **zip 走 Release** | 二进制不要提交进 git。`DownloadLinkInstall` 直接指向 Release 资产 URL 即可，与 `pluginmaster.json` 在哪无关 |

最常见的坑：改了代码、重建了 zip，但忘记改清单里的 `AssemblyVersion` —— 玩家永远收不到更新，因为版本号没变。

---

## 1. 一次性准备

### 1.1 确定作者与仓库地址

插件清单 `plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.json` 里两个字段必须填好：

```json
"Author": "smartwsw",
"RepoUrl": "https://github.com/<你>/SubmarineNotifier"
```

`Author` 会显示在插件列表里；`RepoUrl` 会显示在插件详情页（留空不报错，只是详情页没有链接）。

### 1.2 构建环境

打包需要 **.NET 10 SDK** 与 **API 15 的 Dalamud 程序集**（本项目的 `DalamudApiLevel` 是 15）：

```bash
export DALAMUD_HOME=/path/to/dalamud-api15   # 例：/tmp/dalamud15
```

> `Dalamud.NET.Sdk/15.0.0` 会自动带上 `DalamudPackager`。Release 构建会产出
> `plugin/SubmarineReturnNotifier/bin/Release/SubmarineReturnNotifier/latest.zip`，
> 里面包含 `SubmarineReturnNotifier.dll`、`.Core.dll`、`.deps.json`、`SubmarineReturnNotifier.json`。
> 这是 Dalamud 安装时要求的固定结构，不要手工往 zip 里增删文件。

---

## 2. 打包成仓库

**分工**：`pluginmaster.json` 留在 git 里（raw 直接可读），**zip 上传到 GitHub Release 当资产**。
不要把 zip 提交进仓库 —— 每次发版都多一份二进制，仓库会持续膨胀，clone 和 fetch 都会变慢。

```bash
node .tooling/release/build-repo.mjs \
  --release-base https://github.com/<你>/SubmarineNotifier/releases/download \
  --version 1.0.1.0 \
  --repo-url https://github.com/<你>/SubmarineNotifier

gh release create v1.0.1.0 dist/repo/SubmarineReturnNotifier-1.0.1.0.zip \
  --title v1.0.1.0 --notes "…"
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--release-base` | ✅ | Release 资产前缀。脚本拼成 `<前缀>/v<version>/<zip 名>` |
| `--version` | — | 必须与清单里的 `AssemblyVersion` **完全相同**；省略时用清单值。同时决定 Release tag（`v<version>`） |
| `--repo-url` | — | 写进 `pluginmaster.json` 的 `RepoUrl` |
| `--out` | — | 输出目录，默认 `dist/repo` |
| `--dotnet` | — | dotnet 可执行文件，默认取 `DOTNET` 环境变量或 `dotnet` |
| `--skip-build` | — | 复用已有的 `latest.zip`，不重新构建 |

`verify-repo.mjs` 的 `--proxy` 参数见下一节。

脚本会先做三项校验，任一不通过就退出（在此之前不会产生任何产物）：

1. `Author` 不是占位值（不能等于 `InternalName`）；
2. `InternalName` 与目录约定的 `SubmarineReturnNotifier` 一致；
3. `--version` 与清单 `AssemblyVersion` 一致。

产物：

```
dist/repo/
  pluginmaster.json                      ← 提交进 git，玩家添加的 URL 指向它
  SubmarineReturnNotifier-1.0.1.0.zip    ← 上传到 Release，不进 git（.gitignore 已排除）
```

> zip 带版本号：Release 资产名必须与 `pluginmaster.json` 里链接的文件名一致；
> 带版本号也让旧版本可以继续下载，方便回滚。

---

## 3. 校验（发布前必做）

```bash
# 本地起个静态服务模拟"仓库里的文件"（校验时 --zip-base 指到这里）
node -e "require('http').createServer((q,s)=>require('fs').readFile('dist/repo'+q.url.split('?')[0],(e,d)=>e?(s.writeHead(404),s.end()):s.end(d))).listen(8901)" &

node .tooling/release/verify-repo.mjs --base-url http://127.0.0.1:8901 --zip-base http://127.0.0.1:8901
```

22 项检查，覆盖：

- `pluginmaster.json` 可访问、是数组、必填字段齐全；
- `DalamudApiLevel` 是整数、`Author` 不是占位值；
- zip 可下载、非空，内含主 DLL 与清单；
- **zip 内清单与 `pluginmaster.json` 的 `InternalName` / `AssemblyVersion` / `DalamudApiLevel` / `Author` 逐项一致**
  （不一致时 Dalamud 会装上一个与列表显示版本不同的插件，更新检测从此错乱）；
- **`DownloadLinkInstall` 指向 Release 而不是仓库文件**（防止有人把 zip 又提交回 git）。

`--zip-base` 只影响"下载 zip"这一步，用于本地联调时把生产 URL 换成本地地址；
不带它时脚本按 `pluginmaster.json` 里的真实 URL 下载，也就是发版后的最终校验方式。

直接校验生产地址（推荐发版后立刻跑一次）：

```bash
node .tooling/release/verify-repo.mjs \
  --base-url https://raw.githubusercontent.com/smartwsw/SubmarineNotifier/main/dist/repo
```

> **需要代理时加 `--proxy`**：Node 的 `fetch` 不读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，
> 只设环境变量会得到 `ECONNRESET`。脚本用 curl 接管连接：
>
> ```bash
> node .tooling/release/verify-repo.mjs \
>   --base-url https://raw.githubusercontent.com/smartwsw/SubmarineNotifier/main/dist/repo \
>   --proxy http://127.0.0.1:10809
> ```

全部 PASS 后再进入下一步。

---

## 4. 托管

两样东西分开托管，不需要放在同一个目录：

| 文件 | 托管位置 | 原因 |
|---|---|---|
| `pluginmaster.json` | git 仓库（raw 或 Pages） | 文本、体积小，要能被 `/xlsettings` 直接读取 |
| `<版本>.zip` | **GitHub Release 资产** | 二进制、体积大，不该污染 git 历史 |

Release 资产的好处：不受 raw 的缓存与限流影响、带 `Content-Length` 与 CDN、旧版本可长期保留。

### 4.1 仓库清单托管（三选一）

#### raw.githubusercontent.com（本项目采用）

`https://raw.githubusercontent.com/smartwsw/SubmarineNotifier/main/dist/repo/pluginmaster.json`

最省事。注意 raw 有缓存，发版后可能几分钟才生效：

```bash
curl -s https://raw.githubusercontent.com/<你>/SubmarineNotifier/main/dist/repo/pluginmaster.json | head -3
```

国内直连常被阻断，玩家可改用 jsDelivr 镜像（同一份文件）：

```
https://gcore.jsdelivr.net/gh/smartwsw/SubmarineNotifier@main/dist/repo/pluginmaster.json
```

#### GitHub Pages

1. 把 `dist/repo/pluginmaster.json` 提交到仓库（例如 `main` 分支下的 `dist/repo`）；
2. Settings → Pages → Source 选分支与目录；
3. 得到 `https://<你>.github.io/<仓库>/…/pluginmaster.json`。

优点是 CDN 稳定、没有 raw 的速率限制。

#### Cloudflare Pages / 任意静态托管

上传 `pluginmaster.json` 即可。注意 **不要**放进 `cloud/` 那个 Worker 的静态资源里 ——
那个 Worker 是按路由分发的 API，两者混在一起会让 `/api/v1` 的路由匹配变复杂。

### 4.2 zip 托管

本项目的做法是 GitHub Release：

```bash
gh release create v1.0.0.0 dist/repo/SubmarineReturnNotifier-1.0.0.0.zip --title v1.0.0.0 --notes "…"
```

资产 URL 即 `https://github.com/<你>/<仓库>/releases/download/v<版本>/<zip 名>`，
与 `--release-base` 拼出来的规则一致。

> 用私有仓库时 Release 资产需要鉴权，Dalamud 拿不到，必须改成公开仓库或换其他托管。

---

## 5. 玩家如何添加

在游戏内：

1. `/xlsettings` → **实验性 / Experimental** → **自定义插件仓库 / Custom Plugin Repositories**；
2. 粘贴仓库地址（**必须以 `pluginmaster.json` 结尾**，例如
   `https://raw.githubusercontent.com/<你>/SubmarineNotifier/main/dist/repo/pluginmaster.json`）；
3. 点 `+` 添加并保存；
4. `/xlplugins` → 切到「全部 / All」，搜索 *Submarine Return Notifier*，点安装。

只要 `DalamudApiLevel` 与当前 Dalamud 匹配，插件就会显示为可安装。

---

## 6. 发新版本

```bash
# 1) 改清单版本（这一步最容易漏）
#    plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.json → AssemblyVersion / TestingAssemblyVersion

# 2) 打包（--version 必须与上一步一致，否则脚本会拒绝）
node .tooling/release/build-repo.mjs \
  --release-base https://github.com/smartwsw/SubmarineNotifier/releases/download \
  --version 1.0.2.0

# 3) 上传 zip 到 Release（不是 git commit）
gh release create v1.0.2.0 dist/repo/SubmarineReturnNotifier-1.0.2.0.zip --title v1.0.2.0 --notes "…"

# 4) 提交 pluginmaster.json（只有这一个文件要提交）
git add dist/repo/pluginmaster.json && git commit -m "release v1.0.2.0" && git push

# 5) 校验生产地址
node .tooling/release/verify-repo.mjs \
  --base-url https://raw.githubusercontent.com/smartwsw/SubmarineNotifier/main/dist/repo
```

玩家侧不用做任何事：Dalamud 定期拉取 `pluginmaster.json`，发现 `AssemblyVersion` 更高就在插件列表里标记可更新。

> 旧版本的 Release 可以保留（便于回滚），也可以删。删掉不影响已安装的玩家 —— 他们本地已有文件。
> 但如果还有人在旧版本，删掉资产会让他们的**重装**失败。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 仓库添加成功但列表里没有插件 | `pluginmaster.json` 不是数组，或文件不是 JSON | 用 `verify-repo.mjs` 检查 |
| 插件显示「不兼容」 | `DalamudApiLevel` 与玩家 Dalamud 版本不符 | 游戏大版本更新后需等 Dalamud 升级并重新编译发布 |
| 安装后插件不加载 | zip 结构不对（缺 DLL 或清单），或 API Level 不匹配 | 用 `verify-repo.mjs` 检查 zip 内容 |
| 改了代码但玩家收不到更新 | 忘记改 `AssemblyVersion` | 必须让 `pluginmaster.json` 与清单里的版本一起递增 |
| 更新后玩家版本号显示不对 | `pluginmaster.json` 与 zip 内清单版本不一致 | `verify-repo.mjs` 会直接报出来 |
| 下载 404 | `--release-base` 或 Release tag 写错，或 zip 没上传到 Release | `gh release view v<版本> --json assets` 确认资产名 |
| 下载 404（私有仓库） | Release 资产需要鉴权，Dalamud 拿不到 | 改成公开仓库 |
| raw 链接发版后仍是旧内容 | raw 缓存 | 等几分钟，或改用 Pages / jsDelivr |

---

## 8. 相关文件

| 文件 | 作用 |
|---|---|
| `plugin/SubmarineReturnNotifier/SubmarineReturnNotifier.json` | 插件清单（Author / 版本 / API Level），打包器的输入 |
| `.tooling/release/build-repo.mjs` | 构建 Release + 生成 `pluginmaster.json` 与版本化 zip |
| `.tooling/release/verify-repo.mjs` | 22 项发布前校验 |
| `dist/repo/pluginmaster.json` | 提交进 git，玩家添加的 URL 指向它 |
| `dist/repo/*.zip` | 构建产物，上传到 Release；`.gitignore` 已排除 |
