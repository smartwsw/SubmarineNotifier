# API — Worker HTTP 接口

> Base URL：`https://<worker>.<subdomain>.workers.dev/api/v1`
> 编码：`application/json; charset=utf-8`
> 认证：`Authorization: Bearer <apiToken>`（注册接口除外）

---

## 0. 统一响应格式

成功：

```json
{ "ok": true, "data": { ... } }
```

失败：

```json
{
  "ok": false,
  "error": { "code": "INVALID_TOKEN", "message": "Authentication failed" },
  "requestId": "req_xxx"
}
```

| HTTP | code 示例 | 场景 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 字段缺失/越界 |
| 401 | `INVALID_TOKEN` / `MISSING_TOKEN` | 未认证 |
| 403 | `FORBIDDEN` | token 已吊销/设备被撤销 |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` / `NO_UPCOMING_RETURN` | 唯一约束冲突 / 没有待发返航批次 |
| 429 | `RATE_LIMITED` | 超出频率，含 `Retry-After` 头 |
| 500 | `INTERNAL_ERROR` | 未预期错误 |

> 错误信息不包含 SQL、堆栈、token、推送凭据。

---

## 1. 认证

### `POST /auth/register`

创建用户 + 首个 token。**无需认证。**

```json
// request
{ "deviceName": "PC-主号" }
// response 201
{
  "ok": true,
  "data": {
    "userId": "usr_...",
    "token": "srk_...",          // 仅此一次返回
    "tokenPrefix": "srk_AbCd",
    "deviceId": "dev_...",
    "serverTime": 1762838400
  }
}
```

- token 明文只出现一次；DB 仅存哈希。
- 无邮箱/密码；用户需自行保存 token（插件写入 Dalamud 配置）。

### `POST /auth/device`

为已有用户绑定新设备并签发独立 token。多台设备因此共用同一 `userId` 的潜水艇数据、推送设置与通知历史。

```json
// request（Bearer 认证：用该账号任一设备的 token）
{ "deviceName": "笔记本" }
// response 201
{ "ok": true, "data": { "deviceId": "dev_...", "token": "srk_...", "tokenPrefix": "srk_XxYy" } }
```

> 插件「绑定」页的 **加入已有账号** 走的就是这个接口：粘贴旧设备的完整 token，新设备以独立 token 并入。
> 旧设备不受影响，可随时在 `DELETE /auth/devices/:id` 单独撤销。

### 追加接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/auth/whoami` | 返回 userId、tokenPrefix、deviceId、到期时间 |
| `POST` | `/auth/rotate` | 吊销当前 token，签发新 token（响应同 register 的 token 字段） |
| `POST` | `/auth/revoke` | 吊销当前 token（`{ "allDevices": false }`） |
| `GET` | `/auth/devices` | 设备列表（不含 token） |
| `DELETE` | `/auth/devices/:id` | 撤销设备（同时吊销其 token） |

---

## 2. 潜水艇

### `POST /submarines/sync`

批量上报当前角色全部潜水艇（幂等，可重复调用）。

```json
{
  "characterId": "12345678901234567",
  "characterName": "Dark Knight",
  "worldId": 21,
  "collectedAt": 1762838400,
  "clientTimeOffsetMs": 120,
  "submarines": [
    {
      "slotIndex": 0,
      "name": "U-1",
      "rank": 90,
      "returnAt": 1762842000,
      "routePoints": [101, 102, 0, 0, 0],
      "parts": { "hull": 3, "stern": 2, "bow": 1, "bridge": 4 },
      "state": "sailing"
    },
    {
      "slotIndex": 1,
      "name": "U-2",
      "rank": 45,
      "returnAt": 0,
      "routePoints": [],
      "parts": {},
      "state": "docked"
    }
  ]
}
```

约束：
- `submarines` 长度 0..4；`slotIndex` ∈ 0..3 且唯一。
- `returnAt`：0，或 `[now-7d, now+8d]` 内；越界 → 拒绝该条并返回 warning（不 500）。
- `routePoints`：最多 5 个 0..65535 整数。
- `name` ≤ 40 字符。

**旧快照保护**（同一账号在不同设备/地点登录）

云端按 `collectedAt` 判断新旧：有效采集时刻 = `collectedAt + clientTimeOffsetMs / 1000`，向上截断到服务器当前时间。

- 若某槽位的有效采集时刻**早于**库中该槽位的 `collected_at`，该槽位被丢弃，返回 `stale_snapshot` warning，不覆盖。
- 若整批槽位都被丢弃（`accepted = 0` 且存在陈旧槽位），响应 `stale: true`，且**不会**把"本次没出现的槽位"当成已删除、也不会重算批次——旧快照无法销毁已排定的通知。
- **软删除也带采集时刻**：本次上报里没出现的槽位（`removed`）与 `POST /submarines/remove` 手动删除，
  都会把 `collected_at` 更新为"观察到它不存在"的时刻。因此旧设备拿旧快照回来时，
  这些槽位与在场槽位一样被判为陈旧，**不会被重新激活**（否则已删除的潜水艇会复活）。
- 采集时刻相同 → 后到者生效（避免两台设备互相卡住）。
- `collectedAt = 0`（旧版客户端）或校正后与服务器时间相差超过 1 天 → 视为不可判定，退回后到者生效，不做陈旧比较。

> 同一账号的多台设备各自用独立 token 上报，云端按 `user_id` 合并：潜水艇、推送设置、通知历史都是同一份，
> 冲突由上面的采集时刻规则解决。签发新设备见 `POST /auth/device`。

> `clientTimeOffsetMs` 是插件用 `/health` 返回的 `serverTime` 校准出的偏差（云端时间 − 本机时间），用于让本机时钟不准的设备上报的 `collectedAt` 仍然可比。云端不做信任假设之外的处理：它只用于相对比较。

响应：

```json
{
  "ok": true,
  "data": {
    "accepted": 2,
    "changed": 1,
    "removed": 0,
    "deduped": false,
    "stale": false,
    "serverTime": 1762838450,
    "warnings": [],
    "nextSyncAfter": 1762838750
  }
}
```

- `changed=0` 表示内容与库中一致（未触发重算）。
- 相同 payload 7 天内重复提交 → 直接返回上次结果（`deduped: true`）。
- `stale=true` 表示云端已存有采集时刻更新的数据，本次上报整批被丢弃（见上方「旧快照保护」）。插件据此提示用户，而不是当成上传失败重试。

### `GET /submarines`

```json
{ "ok": true, "data": { "submarines": [ { "id": "...", "characterId": "...", "slotIndex": 0,
  "name": "U-1", "state": "sailing", "returnAt": 1762842000, "remainingSeconds": 3550,
  "rank": 90, "routePoints": [101,102], "updatedAt": 1762838400 } ] } }
```

### `POST /submarines/remove`

```json
{ "submarineId": "sub_..." }        // 或 { "characterId": "...", "slotIndex": 3 }
```
标记 `active=0`，取消其参与的 pending 批次并重算。同时把 `collected_at` 设为当前服务器时间，
因此之后任何采集时刻更早的旧快照都不能把它重新激活。

### `POST /submarines/refresh`

强制将该用户所有 `sailing` 潜艇重新计算通知（用于配置变更后修复）。返回重算摘要。

---

## 3. 设置

### `GET /settings`

```json
{
  "ok": true,
  "data": {
    "mergeWindowMinutes": 10,
    "advanceNotificationMinutes": 5,
    "notificationEnabled": true,
    "provider": "bark",
    "providerServerUrl": "https://api.day.app",
    "providerTopic": "",
    "providerConfigured": true,
    "providerTokenMasked": "••••••••",
    "notifyTitle": "潜水艇返航",
    "notifyGroup": "FF14",
    "notifySound": "",
    "notifyIcon": "",
    "notifyPriority": "active",
    "timezone": "Asia/Shanghai",
    "updatedAt": 1762838400
  }
}
```

> `providerTokenMasked` 只返回掩码；**绝不下发 device key / access token**。

### `PUT /settings`

部分更新；未提供字段不变。

```json
{
  "mergeWindowMinutes": 10,
  "advanceNotificationMinutes": 5,
  "provider": "ntfy",
  "providerServerUrl": "https://ntfy.sh",
  "providerTopic": "ff14-sub-abc123",
  "providerToken": "tk_xxx",           // 可选；写入即加密存储
  "notificationEnabled": true,
  "timezone": "Asia/Shanghai"
}
```

校验：`mergeWindowMinutes ∈ [0,120]`；`advance ∈ {0,1,5,10,15,30}`；
`provider ∈ {bark,ntfy,none}`；URL 必须 https（允许 http 仅限 localhost 测试）；
`topic` 匹配 `^[A-Za-z0-9_-]{1,64}$`；`timezone` 必须为合法 IANA 名称。

变更 `mergeWindow/advance/provider/notificationEnabled` → 触发重算。

---

## 4. 推送

### `POST /push/test`

```json
{ "provider": "bark", "serverUrl": "https://api.day.app", "deviceKey": "xxx",
  "title": "测试", "body": "来自 Submarine Notifier", "group": "FF14" }
```

- 未提供参数时使用已保存配置（`providerToken` 从加密存储解出）。
- 返回 `{ ok: true, data: { delivered: true, provider: "bark", latencyMs: 412 } }`
- 推送失败返回 `502` + `error.code = PUSH_FAILED`，`message` 含服务端返回码（不含 key）。
- 内容固定（标题「Submarine Notifier 测试」），只用来验证凭据能否送达。

### `POST /push/next`

立即把**下一次真实返航通知**推送一次（插件「推送」页的「立即发送下次返航」按钮）。

无请求体（`{}` 亦可）。返回：

```json
{ "ok": true, "data": {
  "delivered": true, "provider": "bark", "latencyMs": 96,
  "kind": "returned", "notifyAt": 1762842000, "returnAt": 1762842000,
  "shipCount": 2, "title": "潜水艇返航"
} }
```

- 内容取自云端已排定的第一个非空 pending 批次，按正常投递同样的模板/时区渲染，
  因此收到什么就是正式通知会发什么。
- `kind`：该批次提前通知尚未发出时为 `advance`（标题带「（即将返航）」），否则为 `returned`。
- **不影响排程**：不写 `ret:`/`adv:` 幂等键，不改批次状态、不推进重试、不重算 alarm，
  正式通知仍会按原计划再发一次。仅写一条 `event_type = next` 的审计日志。
- 错误：`409 NO_UPCOMING_RETURN`（没有待发批次，通常是还没上报数据）、
  `400 NOTIFICATIONS_DISABLED`（已关闭返航通知）、`400 PROVIDER_NOT_CONFIGURED`、
  `502 PUSH_FAILED`。限流 10 次/分钟/用户。

### 统一 Provider 接口（实现约定）

```ts
interface PushProvider {
  getProviderName(): string;
  validateConfiguration(config: PushConfig): ValidationResult;
  sendNotification(msg: PushMessage, config: PushConfig): Promise<PushResult>;
  testNotification(config: PushConfig): Promise<PushResult>;
}
```

### BarkProvider

- `POST {serverUrl}/push`，JSON：`title/body/device_key/group/sound/icon/level/url`
- `serverUrl` 默认 `https://api.day.app`
- 成功判定：HTTP 2xx 且响应 `code === 200`（Bark 服务端约定）。响应非 JSON 时按 2xx 视为成功。

### NtfyProvider

- `POST {serverUrl}/{topic}`，body 为正文，头：
  - `Title`、`Priority`（`min|low|default|high|urgent` 或 1..5）、`Tags`、`Click`
  - `Authorization: Bearer <token>`（若配置）
- `serverUrl` 默认 `https://ntfy.sh`
- 成功判定：HTTP 2xx。

---

## 5. 状态与日志

### `GET /status`

```json
{
  "ok": true,
  "data": {
    "userId": "usr_...",
    "serverTime": 1762838400,
    "scheduler": { "nextAlarmAt": 1762842000, "pendingBatches": 2 },
    "submarines": { "total": 4, "sailing": 3, "returned": 1, "docked": 0 },
    "lastSyncAt": 1762838300,
    "lastNotification": { "eventType": "advance", "status": "sent", "at": 1762841100 },
    "providerConfigured": true,
    "notificationEnabled": true
  }
}
```

### `GET /notifications?limit=20`

已发送/待发送批次列表（含成员数量与返航时间）。

### `GET /logs?limit=50&type=error`

最近日志（`event_type` 过滤）。`error_message` 已脱敏。

---

## 6. 账号

### `DELETE /account`

```json
{ "confirm": "DELETE" }
```

级联删除用户、设备、token、潜艇、设置、批次、日志，并清理 DO alarm。返回 204。

---

## 7. 限流

| 范围 | 限制 | 响应 |
|---|---|---|
| `POST /submarines/sync` | 60 次/分钟/用户 | 429 + `Retry-After: 30` |
| `POST /push/test` | 10 次/分钟/用户 | 同上 |
| `POST /push/next` | 10 次/分钟/用户 | 同上 |
| 其余认证接口 | 120 次/分钟/IP | 同上 |
| `POST /auth/register` | 5 次/小时/IP | 同上 |

---

## 8. 插件与云端共享模型

插件侧 DTO（C#）与本文档 JSON 一一对应，字段名为 `camelCase`：

| C# 属性 | JSON |
|---|---|
| `CharacterId` | `characterId` |
| `SlotIndex` | `slotIndex` |
| `ReturnAt`（`long` Unix 秒） | `returnAt` |
| `RoutePoints`（`int[]`） | `routePoints` |
| `ClientTimeOffsetMs` | `clientTimeOffsetMs` |

序列化统一 `System.Text.Json` + `JsonNamingPolicy.CamelCase`。
