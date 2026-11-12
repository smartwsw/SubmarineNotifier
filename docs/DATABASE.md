# DATABASE — Cloudflare D1 Schema

> 阶段：Phase 2
> 迁移文件：`cloud/migrations/0001_initial.sql`
> 约定：**所有时间均为 INTEGER Unix 秒（UTC）**；所有主键为 TEXT（UUID/自定义 ID）；所有 SQL 参数化。

---

## 1. ER 概览

```
users 1───n devices
  │
  ├──1───n api_tokens
  ├──1───1 user_settings
  ├──1───n submarines ──1───n notification_batch_items ───n───1 notification_batches
  └──1───n notification_logs
```

---

## 2. 表定义

### 2.1 `users`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `usr_` + 24 字符 base62 |
| `created_at` | INTEGER | NOT NULL | Unix 秒 |
| `updated_at` | INTEGER | NOT NULL | |
| `status` | TEXT | NOT NULL DEFAULT 'active' | `active` / `disabled` / `deleted` |

### 2.2 `devices`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `dev_` + 24 |
| `user_id` | TEXT | NOT NULL, FK→users(id) ON DELETE CASCADE | |
| `device_name` | TEXT | NOT NULL DEFAULT '' | 玩家可读名（如"PC-主号"） |
| `created_at` | INTEGER | NOT NULL | |
| `last_seen_at` | INTEGER | NOT NULL | 每次认证成功更新 |
| `status` | TEXT | NOT NULL DEFAULT 'active' | `active` / `revoked` |

索引：`idx_devices_user (user_id, status)`

### 2.3 `api_tokens`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `tok_` + 24 |
| `user_id` | TEXT | NOT NULL, FK ON DELETE CASCADE | |
| `device_id` | TEXT | NULL, FK→devices(id) ON DELETE SET NULL | 设备绑定 |
| `token_hash` | TEXT | NOT NULL UNIQUE | `SHA-256(token)` hex |
| `token_prefix` | TEXT | NOT NULL | 前 8 位，仅 UI 展示 |
| `created_at` | INTEGER | NOT NULL | |
| `last_used_at` | INTEGER | NULL | |
| `expires_at` | INTEGER | NULL | NULL = 不过期 |
| `revoked_at` | INTEGER | NULL | 非 NULL 即失效 |
| `rotated_from` | TEXT | NULL | 轮换来源 token id |

索引：`idx_tokens_user (user_id, revoked_at)`，`idx_tokens_hash (token_hash)`

> **明文 token 只在创建/轮换响应中出现一次**，服务端从不存储明文。

### 2.4 `submarines`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `sub_` + 24 |
| `user_id` | TEXT | NOT NULL, FK ON DELETE CASCADE | |
| `character_id` | TEXT | NOT NULL | 角色 ContentId（十进制字符串） |
| `character_name` | TEXT | NOT NULL DEFAULT '' | 展示用 |
| `world_id` | INTEGER | NULL | `World` 表行 ID |
| `slot_index` | INTEGER | NOT NULL | 0..3（稳定键） |
| `submarine_name` | TEXT | NOT NULL DEFAULT '' | 玩家可改名 |
| `state` | TEXT | NOT NULL | `unknown`/`sailing`/`returned`/`docked` |
| `return_at` | INTEGER | NOT NULL DEFAULT 0 | **Unix 秒；0 = 无航行** |
| `rank` | INTEGER | NOT NULL DEFAULT 0 | 等级 |
| `route_points` | TEXT | NOT NULL DEFAULT '[]' | JSON int[]，最多 5 项 |
| `parts` | TEXT | NOT NULL DEFAULT '{}' | JSON `{hull,stern,bow,bridge}` |
| `collected_at` | INTEGER | NOT NULL DEFAULT 0 | 客户端采集时刻，**按服务器时间轴校正后**写入；用于拒绝旧快照覆盖（见 API.md「旧快照保护」）。0 = 不可判定。**软删除时同样更新**为该槽位"被观察到不存在"的时刻，旧设备因此无法把它复活 |
| `last_uploaded_at` | INTEGER | NOT NULL | 本行最后被 sync 的时刻 |
| `updated_at` | INTEGER | NOT NULL | |
| `active` | INTEGER | NOT NULL DEFAULT 1 | 0 = 已移除/失效（软删除） |

唯一约束：`UNIQUE(user_id, character_id, slot_index)`
索引：`idx_subs_user_char (user_id, character_id, active)`，`idx_subs_return (user_id, active, return_at)`

> 说明：`character_id` 用字符串存储（ContentId 为 64 位，JS number 不安全）。

### 2.5 `user_settings`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `user_id` | TEXT | PK, FK ON DELETE CASCADE | |
| `merge_window_minutes` | INTEGER | NOT NULL DEFAULT 10 | 0..120 |
| `advance_notification_minutes` | INTEGER | NOT NULL DEFAULT 5 | ∈ {0,1,5,10,15,30} |
| `notification_enabled` | INTEGER | NOT NULL DEFAULT 1 | 0/1 |
| `provider` | TEXT | NOT NULL DEFAULT 'bark' | `bark` / `ntfy` / `none` |
| `provider_server_url` | TEXT | NOT NULL DEFAULT '' | 自定义服务器（空 = 官方默认） |
| `provider_token_enc` | TEXT | NOT NULL DEFAULT '' | AES-GCM 密文（Bark device key / ntfy token） |
| `provider_topic` | TEXT | NOT NULL DEFAULT '' | ntfy topic（Bark 时为空） |
| `notify_title` | TEXT | NOT NULL DEFAULT '潜水艇返航' | |
| `notify_body_template` | TEXT | NOT NULL DEFAULT '' | 空 = 内置模板 |
| `notify_group` | TEXT | NOT NULL DEFAULT 'FF14' | |
| `notify_sound` | TEXT | NOT NULL DEFAULT '' | Bark sound / ntfy 忽略 |
| `notify_icon` | TEXT | NOT NULL DEFAULT '' | URL |
| `notify_priority` | TEXT | NOT NULL DEFAULT 'default' | bark: active/timeSensitive/critical/passive；ntfy: min..urgent |
| `timezone` | TEXT | NOT NULL DEFAULT 'UTC' | IANA |
| `updated_at` | INTEGER | NOT NULL | |

> 兼容性说明：早期 Bark 专用列（`bark_server_url`/`bark_device_key`/...）不再单独建表，
> 统一走 `provider_*`，避免多平台字段重复；`notify_*` 为平台无关展示字段。

### 2.6 `notification_batches`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `bat_` + 24 |
| `user_id` | TEXT | NOT NULL, FK ON DELETE CASCADE | |
| `anchor_return_at` | INTEGER | NOT NULL | 批次锚点（最早返航） |
| `latest_return_at` | INTEGER | NOT NULL | 批次最晚返航 = notifyAt 基准 |
| `notify_at` | INTEGER | NOT NULL | 正式通知时刻（=latest_return_at） |
| `advance_notify_at` | INTEGER | NULL | NULL = 不发送提前通知 |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending`/`sent`/`cancelled` |
| `advanced_sent_at` | INTEGER | NULL | 提前通知发送时刻 |
| `sent_at` | INTEGER | NULL | 正式通知发送时刻 |
| `attempt_count` | INTEGER | NOT NULL DEFAULT 0 | 推送失败计数 |
| `next_retry_at` | INTEGER | NULL | 退避时间 |
| `last_error` | TEXT | NULL | 最近错误（已脱敏） |
| `created_at` | INTEGER | NOT NULL | |
| `updated_at` | INTEGER | NOT NULL | |

索引：`idx_batches_due (user_id, status, notify_at)`，`idx_batches_advance (user_id, status, advance_notify_at)`

### 2.7 `notification_batch_items`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `batch_id` | TEXT | NOT NULL, FK→notification_batches(id) ON DELETE CASCADE | |
| `submarine_id` | TEXT | NOT NULL, FK→submarines(id) ON DELETE CASCADE | |
| `return_at` | INTEGER | NOT NULL | 入批时的返航时间快照 |

主键：`PRIMARY KEY (batch_id, submarine_id)`
索引：`idx_items_sub (submarine_id)`

### 2.8 `notification_logs`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | `log_` + 24 |
| `user_id` | TEXT | NOT NULL, FK ON DELETE CASCADE | |
| `batch_id` | TEXT | NULL | 无批次事件为空 |
| `event_type` | TEXT | NOT NULL | `advance`/`returned`/`test`/`next`/`sync`/`error` |
| `event_key` | TEXT | NOT NULL UNIQUE | **幂等键**：`ret:{subId}:{returnAt}`、`adv:{userId}:{notifyAt}`；`test`/`next` 用 `{type}:{userId}:{now}:{uuid}`，**不参与返航幂等** |
| `status` | TEXT | NOT NULL | `sending`/`sent`/`failed`/`skipped` |
| `provider` | TEXT | NOT NULL DEFAULT '' | |
| `attempts` | INTEGER | NOT NULL DEFAULT 1 | |
| `error_message` | TEXT | NULL | 脱敏 |
| `created_at` | INTEGER | NOT NULL | |

索引：`idx_logs_user (user_id, created_at DESC)`

### 2.9 `rate_limits`（限流计数）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | TEXT | PK | 如 `u:{userId}:{minuteBucket}` / `ip:{ip}:{minuteBucket}` |
| `count` | INTEGER | NOT NULL DEFAULT 0 | |
| `expires_at` | INTEGER | NOT NULL | 过期清理 |

索引：`idx_rl_expires (expires_at)`

### 2.10 `sync_dedup`（上传内容去重）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `hash` | TEXT | PK | `{userId}:{sha256(payload)}` |
| `user_id` | TEXT | NOT NULL, FK ON DELETE CASCADE | |
| `created_at` | INTEGER | NOT NULL | |

---

## 3. 事务与一致性

`POST /submarines/sync` 单次请求涉及：

```
BEGIN
  upsert submarines（逐条）
  对 changed 的潜艇：DELETE FROM notification_batch_items
                      WHERE submarine_id = ? AND batch_id IN
                            (SELECT id FROM notification_batches
                             WHERE status='pending' AND user_id = ?)
  将成员为空的 pending 批次标记 cancelled
COMMIT
然后（事务外）replan + setAlarm
```

D1 支持 `batch()` 与显式事务语义（`BEGIN`/`COMMIT` 由 `batch` 原子执行）；
实现中将把上述语句放入一个 `batch`，保证原子性。

---

## 4. 索引设计理由

| 索引 | 支撑查询 |
|---|---|
| `idx_tokens_hash` | 每次认证（最高频） |
| `idx_subs_user_char` | 按角色列潜艇 |
| `idx_subs_return` | 配额/状态页、重算候选 |
| `idx_batches_due` | 到期批次扫描（DO alarm） |
| `idx_batches_advance` | 提前通知到期扫描 |
| `idx_logs_user` | 最近日志/审计 |
| `idx_rl_expires` | 过期清理（可由 DO 顺带执行） |

---

## 5. 迁移与初始化

```bash
cd cloud
npx wrangler d1 create submarine-notifier            # 得到 database_id 写入 wrangler.toml
npx wrangler d1 migrations apply submarine-notifier --local
npx wrangler d1 migrations apply submarine-notifier --remote
```

- 迁移文件按序号命名，`wrangler d1 migrations apply` 自动跟踪已应用版本。
- 所有迁移都必须可重复执行（`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`）。
- 生产变更使用新增迁移文件，禁止修改历史迁移。

---

## 6. 容量与清理

| 项 | 策略 |
|---|---|
| `notification_logs` | 保留 90 天；由 DO 每小时顺带删除过期行（无需 cron 扫描全部用户） |
| `sync_dedup` | 保留 7 天，同步清理 |
| `notification_batches(sent/cancelled)` | 保留 90 天 |
| `rate_limits` | `expires_at` 过期即删 |
| 用户删除 | `DELETE FROM users WHERE id=?` 级联清空（外键 ON DELETE CASCADE） |

> D1 免费额度（截至官方文档）：5 GB 存储、500 万行读/天、10 万行写/天。
> 本系统每用户每天写入量约几十行，个人/小规模使用远低于免费额度。
