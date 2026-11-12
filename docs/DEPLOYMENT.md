# DEPLOYMENT — 部署 Cloudflare 云端

> 本文档面向**自建服务的人**（自己部署 Worker）。只想用别人的服务？看 [USER_GUIDE.md](USER_GUIDE.md)。

所有命令都在 `cloud/` 目录下执行。

---

## 0. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **22.12 或更高**（Wrangler 4 的硬性要求） | `node -v` |
| npm | 随 Node 安装 | `npm -v` |
| Cloudflare 账号 | 免费计划即可（但见 §1 关于 DO 的说明） | — |
| Durable Objects | 需要当前套餐支持 SQLite 后端的 DO | 见下 |

```bash
cd cloud
npm install
npx wrangler --version     # 应为 4.x
npx wrangler whoami        # 首次会引导 wrangler login
```

如果 `wrangler whoami` 报未登录，执行 `npx wrangler login`，浏览器里授权后回到终端。

> **关于 Durable Objects 与套餐**：本项目每个用户使用一个 SQLite 后端的 Durable Object（`SchedulerDurableObject`）。Cloudflare 对免费计划开放 SQLite DO 的策略会变化，若 `wrangler deploy` 报 `Durable Objects are not available on your plan`，需要在控制台升级到 Workers Paid。以你账号的实际报错与 <https://developers.cloudflare.com/durable-objects/platform/pricing/> 为准。

---

## 1. 创建 D1 数据库

```bash
npx wrangler d1 create submarine-notifier
```

输出类似：

```
✅ Successfully created DB 'submarine-notifier'
[[d1_databases]]
binding = "DB"
database_name = "submarine-notifier"
database_id = "1a2b3c4d-5e6f-7890-abcd-ef1234567890"
```

把 `database_id` 填进 `wrangler.toml`，替换占位符：

```toml
[[d1_databases]]
binding = "DB"
database_name = "submarine-notifier"
database_id = "1a2b3c4d-5e6f-7890-abcd-ef1234567890"   # ← 改这里
migrations_dir = "migrations"
```

> `database_id` 不是机密，可以提交到仓库；但每个部署实例必须是自己的 ID。

**不要**修改 `name`（`submarine-notifier`），后续命令都用这个名字定位数据库。

> **报错 `Invalid property: databaseId => Invalid uuid [code: 7400]`**
> 说明 `wrangler.toml` 里还是占位符 `REPLACE_WITH_D1_DATABASE_ID`，Wrangler 把它当 UUID 发给了 Cloudflare API。
> 用 `npx wrangler d1 list` 查出真实 UUID（或重新执行第 1 步看输出），替换后重试。
> 如果不确定账号里是否已经建过，先 `npx wrangler d1 list` 看看——重复执行 `d1 create` 会建出第二个同名数据库。

---

## 2. 设置加密密钥

Bark Device Key / ntfy Access Token 在 D1 中以 AES-256-GCM 加密存储，密钥来自 Worker secret `SECRETS_KEY`，必须是 **32 字节的 base64**：

```bash
openssl rand -base64 32
# 例：mD1ztlvn+tJpnrFuS2xBKFgF3HeOn5JC8a8ACVgjXf4=
npx wrangler secret put SECRETS_KEY
# 粘贴上一步的输出后回车
```

- 这个密钥不能写进 `wrangler.toml`，也不能提交到仓库。
- **一旦更换 `SECRETS_KEY`，所有已保存的推送凭据都无法解密**，用户必须重新填写 Bark Key。
- 备份建议：把密钥存进密码管理器。

---

## 3. 应用数据库迁移

```bash
npx wrangler d1 migrations apply submarine-notifier --remote
```

首次执行会创建全部 9 张表（`users`、`devices`、`api_tokens`、`submarines`、`user_settings`、`notification_batches`、`notification_batch_items`、`notification_logs`、`rate_limits`、`sync_dedup`）。

再次执行应输出 `✅ No migrations to apply!` —— 迁移是幂等的。

> 本地开发用 `--local` 代替 `--remote`，数据落在 `.wrangler/state/`。
> 想在空库上验证迁移能否重复执行：`npx wrangler d1 migrations apply submarine-notifier --local --persist-to /tmp/d1-fresh`。

---

## 4. 部署

```bash
npx wrangler deploy
```

输出会包含 Worker 地址：

```
Published submarine-notifier (1.2 sec)
  https://submarine-notifier.<你的子域>.workers.dev
```

> **报错 `You need a workers.dev subdomain in order to proceed. [code: 10063]`**
> 账号还没创建过 workers.dev 子域（新账号常见）。去 Dashboard 打开一次 Workers & Pages 页面会自动生成；
> 也可以直接用 API 指定一个（子域全局唯一，冲突时换一个）：
>
> ```bash
> curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/subdomain" \
>   -H "Authorization: Bearer <API_TOKEN>" -H 'content-type: application/json' \
>   -d '{"subdomain":"your-unique-prefix"}'
> ```
>
> 建好后重新 `npx wrangler deploy` 即可。最终地址是 `https://<worker-name>.<subdomain>.workers.dev`。

### 4.1 验证

```bash
curl https://submarine-notifier.<你的子域>.workers.dev/api/v1/health
# {"ok":true,"data":{"status":"ok","serverTime":1794480000}}
```

`/health` 不需要认证，用来区分「地址错」与「token 错」。

> **部署成功但 curl 连不上（`Couldn't connect` / `SSL_connect: Connection was reset`）**
> 先用 DNS-over-HTTPS 确认真实 IP，排除本机 DNS 被污染：
>
> ```bash
> curl -s 'https://cloudflare-dns.com/dns-query?name=submarine-notifier.<子域>.workers.dev&type=A' \
>   -H 'accept: application/dns-json'
> ```
>
> 如果这里返回的是 Cloudflare 网段（`104.x` / `172.67.x`），而本机 `nslookup` 给出的是无关 IP（例如 Facebook 的 `31.13.x`），
> 说明是本机 DNS 被劫持，不是 Worker 的问题。可临时绕过验证：
>
> ```bash
> curl -s --resolve "submarine-notifier.<子域>.workers.dev:80:<真实IP>" \
>   "http://submarine-notifier.<子域>.workers.dev/api/v1/health"
> ```
>
> 长期使用请在插件里配置可用网络，或给 Worker 绑定自定义域名（见 §6）。443 端口被重置时 80 端口通常仍可用于验证。

再注册一个测试账号：

```bash
curl -X POST https://submarine-notifier.<你的子域>.workers.dev/api/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"deviceName":"deploy-check"}'
# {"ok":true,"data":{"userId":"usr_...","token":"srk_...","tokenPrefix":"srk_...","deviceId":"dev_..."}}
```

拿到 token 后可以立刻删除这个测试账号，避免占用注册限流额度：

```bash
curl -X DELETE https://submarine-notifier.<你的子域>.workers.dev/api/v1/account \
  -H "authorization: Bearer <token>" -H 'content-type: application/json' \
  -d '{"confirm":"DELETE"}'
```

---

## 5. 配置文件说明

### 5.1 `wrangler.toml`

```toml
name = "submarine-notifier"                 # Worker 名，也是 D1 名
main = "src/index.ts"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "submarine-notifier"
database_id = "REPLACE_WITH_D1_DATABASE_ID" # 必须改成你自己的
migrations_dir = "migrations"

[[durable_objects.bindings]]
name = "SCHEDULER"
class_name = "SchedulerDurableObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["SchedulerDurableObject"]

[vars]
ENVIRONMENT = "production"                  # 生产默认：推送地址必须 https

[observability]
enabled = true
```

关键点：

- `ENVIRONMENT = "production"` 时**只允许 https 推送地址**，`DEV_INSECURE_PUSH_HOSTS` 完全不生效。
- `new_sqlite_classes` 声明使用 SQLite 后端 DO；一旦部署后不要改动已经发布过的 `[[migrations]] tag`。
- `observability.enabled = true` 打开 Workers Logs，便于排查推送失败。

### 5.2 `.dev.vars`（仅本地）

本地 `wrangler dev` 会用 `.dev.vars` 覆盖 `[vars]`：

```
SECRETS_KEY=<本地随机值>
ENVIRONMENT=dev
DEV_INSECURE_PUSH_HOSTS=localhost,127.0.0.1
```

`.dev.vars` 已在 `.gitignore` 中。`.dev.vars.example` 是模板。

> **不要**把 `.dev.vars` 里的内容 `wrangler secret put` 到生产，也不要让生产环境使用 `ENVIRONMENT=dev`。

---

## 6. 自定义域名（可选）

在 `wrangler.toml` 增加：

```toml
routes = [
  { pattern = "subnotify.example.com", custom_domain = true }
]
```

然后重新 `npx wrangler deploy`。域名需已在该 Cloudflare 账号下托管。

---

## 7. 升级

```bash
cd cloud
git pull                      # 或替换代码
npm install                   # 依赖有变化时
npx wrangler d1 migrations apply submarine-notifier --remote   # 有新迁移时
npx wrangler deploy
```

- 新迁移文件按 `0002_xxx.sql` 命名，**只增不改**已发布的迁移。
- 部署是原地更新，D1 数据与 DO 状态保留。

---

## 8. 回滚

```bash
npx wrangler deployments list
npx wrangler rollback [deployment-id]
```

- 回滚只回退 Worker 代码，**不回退 D1 迁移**。如果新版本写了新表，旧版本代码仍能运行（旧代码不读新表），但新表会留在库里。
- 若迁移本身有问题，需要写一个反向迁移（例如 `0003_revert_xxx.sql`）并部署。

---

## 9. 监控与日志

```bash
npx wrangler tail              # 实时日志
npx wrangler tail --format pretty
```

或在控制台 → Workers & Pages → submarine-notifier → Logs 查看。

日志中**不会**出现 token、Bark Key 或解密后的推送凭据：

- 插件侧所有日志经过 `Redaction.Apply`（`srk_***`、URL 中的 key 段替换）。
- 云端错误只记录 `requestId`、`path` 和异常 message。

---

## 10. 备份

D1 导出：

```bash
npx wrangler d1 export submarine-notifier --remote --output backup-$(date +%F).sql
```

恢复：`npx wrangler d1 execute submarine-notifier --remote --file backup-YYYY-MM-DD.sql`。

DO 里只存 `userId`、最近一次 alarm 运行结果与清理时间戳；这些是**可重建的**——只要 D1 数据还在，下一次 sync 或 alarm 会重新计算排程。

---

## 11. 部署检查清单

- [ ] `wrangler.toml` 的 `database_id` 已替换（不是 `REPLACE_WITH_D1_DATABASE_ID`）
- [ ] `ENVIRONMENT = "production"`，且未设置 `DEV_INSECURE_PUSH_HOSTS`
- [ ] `SECRETS_KEY` 已用 `wrangler secret put` 设置，长度经校验（base64 → 32 字节）
- [ ] `.dev.vars` 不在仓库里（`git status` 确认）
- [ ] 迁移已在远端执行，重复执行显示 "No migrations to apply!"
- [ ] `/api/v1/health` 返回 `{"ok":true}`
- [ ] 注册 → `/push/test` 能收到手机通知
- [ ] `npx wrangler tail` 中看不到 token / device key
