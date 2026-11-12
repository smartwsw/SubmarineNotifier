# SECURITY — 安全设计

> 阶段：Phase 2 设计 + Phase 6 检查清单

---

## 1. 身份与凭据

### 1.1 用户与 token

- 注册即创建 `userId`（`usr_` + 24 位 base62），无需邮箱/密码。
- API token 格式：`srk_` + 32 字节 CSPRNG（base64url，43 字符）。
- 生成：`crypto.getRandomValues(new Uint8Array(32))` → base64url。
- 存储：仅 `SHA-256(token)`（hex）。`token_prefix`（前 8 字符）用于 UI 识别。
- **明文 token 只在注册/轮换的响应体中出现一次**；之后无法找回，只能轮换。
- 轮换：生成新 token → 旧 token 写 `revoked_at` → 返回新明文。
- 撤销：`revoked_at` 非空即认证失败（403）。

### 1.2 设备绑定

- 每次 `POST /auth/device` 签发独立 token，绑定 `device_id`。
- 撤销设备时一并吊销该设备 token。
- 设备删除不影响同一用户的其他设备。

### 1.3 认证流程

```
Authorization: Bearer srk_xxx
  → 取 token_prefix 前 16 位做 DB 索引提示（可选优化）
  → SELECT ... WHERE token_hash = sha256(token) AND revoked_at IS NULL
  → 检查 expires_at
  → 校验 device 状态（若 token 绑定设备）
  → 更新 last_used_at / devices.last_seen_at（节流：>60s 才写）
```

常量时间比较：哈希后比较使用固定长度比较函数（避免定时侧信道；D1 查询本身返回布尔即可）。

---

## 2. 数据隔离

- 所有业务 SQL 均含 `WHERE user_id = ?`，参数来自认证结果，**不来自请求体**。
- 请求体中的 `userId` 字段一律忽略。
- 资源按 id 访问时（如 `DELETE /auth/devices/:id`），同时校验 `user_id`。
- 唯一约束 `(user_id, character_id, slot_index)` 防止跨用户覆盖。

**测试要求**：每个资源接口必须有"用户 A 无法读取/修改用户 B 资源"的用例。

---

## 3. 推送凭据保护

| 项 | 做法 |
|---|---|
| 存储 | AES-256-GCM 加密，`iv(12B) + ciphertext + tag(16B)` → base64 |
| 密钥 | Worker secret `SECRETS_KEY`（32 字节 base64），使用 `crypto.subtle` 导入 |
| AAD | `user_id`，防止密文被跨用户复用 |
| 下发 | API 只返回 `providerTokenMasked`（固定 `••••••••`）与 `providerConfigured` |
| 日志 | 任何日志不得包含解密后的 key；错误信息中若上游回显 URL/参数，需剔除 |
| 测试接口 | 允许临时传入 key 进行测试，但**不落库、不写日志** |

---

## 4. 传输与请求校验

- 仅 HTTPS（Workers 默认）。自定义 Bark/ntfy URL 默认要求 `https://`；
  仅在 `ENVIRONMENT=dev` 且 host 为 `localhost`/`127.0.0.1` 时允许 http。
- 请求体限制：`Content-Length` ≤ 64 KB；JSON 解析失败 → 400。
- 字段校验：类型、长度、范围、枚举白名单（详见 `API.md`）。
- 所有 SQL 使用 `env.DB.prepare(...).bind(...)`，**禁止字符串拼接**。
- 输出转义：通知正文中的用户可控字段做长度截断（标题 ≤ 120，正文 ≤ 2000）。

---

## 5. 限流与滥用防护

| 接口 | 限制 | 实现 |
|---|---|---|
| `register` | 5/h/IP | `rate_limits` 表，`key = ip:{hash(ip)}:{hourBucket}` |
| 认证接口 | 120/min/IP | 同上（分钟桶） |
| `sync` | 60/min/user | `key = u:{userId}:{minuteBucket}` |
| `push/test` | 10/min/user | 同上 |
| `push/next` | 10/min/user | 同上 |

- IP 只存 HMAC-SHA256(ip, SECRETS_KEY) 前 16 hex，不存原始 IP。
- 超限返回 429 + `Retry-After`。
- 过期行由 DO 每小时清理。

---

## 6. 日志脱敏规则

禁止输出：
- 完整 token、`Authorization` 头
- `device_key`、ntfy 访问 token
- 完整请求体（仅输出长度与字段名）

允许输出：
- `userId`、`tokenPrefix`、`batchId`、`eventType`、HTTP 状态码、错误码、耗时

---

## 7. 插件侧安全

- token 存在 Dalamud 配置目录（`pluginConfigs/SubmarineReturnNotifier.json`），由 Dalamud 管理。
- 配置界面默认掩码显示 token，提供"显示/隐藏"与"清除并重新绑定"。
- 日志面板只显示最近 N 条，token 打码。
- HTTP 使用 `HttpClient` + `User-Agent: SubmarineReturnNotifier/<version>`；不接受/解析非 JSON 响应中的 HTML。
- 不在聊天框输出敏感信息；调试命令需显式参数才打印原始报文。

---

## 8. 账号删除

`DELETE /account` 要求 body 含 `{ "confirm": "DELETE" }`：
1. 吊销所有 token（逻辑删除）
2. 级联删除全部 D1 数据
3. 调用 DO 删除 storage + `deleteAlarm()`
4. 返回 204

---

## 9. 上线检查清单（Phase 6）

以下各项均已实际验证，验证方式写在条目后。

- [x] 所有 SQL 参数化 — `grep -rn "prepare(\`.*\$\{" cloud/src` 无匹配；全部走 `.bind()`
- [x] 所有路由（除 `/auth/register`、`/health`）在 `authenticate()` 之后分发 — `src/index.ts:95`
- [x] 用户隔离测试全绿 — `tests/auth.test.ts` `用户隔离：A 的 token 看不到 B 的设备与潜艇`
- [x] token 仅创建时返回一次 — 注册/新增设备/轮换响应各返回一次，其余接口只返回 `tokenPrefix`
- [x] DB 中无明文 token / device key — `api_tokens.token_hash` 为 SHA-256；`user_settings.provider_token_enc` 为 AES-256-GCM；`tests/delivery.test.ts` 断言存储值不含明文
- [x] 日志样例中无敏感字段 — 插件侧 `Redaction.Apply` 覆盖全部日志出口（`Utilities/Logger.cs`）；云端仅记录 `requestId`/`path`/异常 message
- [x] 限流生效 — `tests/rate-limit.test.ts` 验证第 11 次请求返回 429 `RATE_LIMITED`，且按用户隔离
- [x] `SECRETS_KEY` 通过 `wrangler secret put` 设置，未写入仓库 — 仅在 `.dev.vars`（已 gitignore）与 `.dev.vars.example`（占位符）
- [x] `.dev.vars` 在 `cloud/.gitignore` 中
- [x] 迁移可在空库与已有库上重复执行 — `wrangler d1 migrations apply --persist-to /tmp/d1-fresh` 后再次执行为 `No migrations to apply!`
- [x] 404/500 响应不含堆栈 — `tests/errors.test.ts` 断言响应体不含 `no such table`、表名或 `.ts:` 源码位置
