# ARCHITECTURE — 潜水艇返航通知系统

> 阶段：Phase 2（架构设计）
> 前置：`docs/RESEARCH.md`（已确认返航时间可直接读取）

---

## 1. 总览

```
┌───────────────────────────────┐            ┌─────────────────────────────────────┐
│ Dalamud 插件 (C#, API 15)     │            │ Cloudflare Worker (TypeScript)      │
│                               │  HTTPS     │                                     │
│ SubmarineScanner ─┐           │  JSON      │  routes/  (auth, submarine,         │
│   (读工坊内存)     │           │  + Bearer  │            settings, push, account) │
│                   ▼           │            │     │                               │
│   Snapshot  ─► Diff ─► Queue ─┼───────────►│  services/ (submarine, notification,│
│                   │           │            │            scheduler, push)          │
│                   ▼           │            │     │                               │
│   LocalCache (JSON)           │            │  storage/repository (D1)            │
│   (pending/uploads)           │            │     │                               │
└───────────────────────────────┘            │  Durable Objects: Scheduler         │
                                             │   storage: alarm + state            │
                                             │     │                               │
                                             │     ▼  BarkProvider / NtfyProvider  │
                                             └─────────────────────────────────────┘
```

**职责边界**
- 插件：只负责"采集 + 上报"。不做推演、不发通知、不依赖云端在线。
- 云端：持久化返航事件、合并批次、调度推送、幂等去重、失败重试。
- 两者只通过 HTTPS JSON 交互；插件停机不影响已排定的通知。

---

## 2. 数据流

### 2.1 上报（插件 → Worker）

1. `SubmarineScanner` 在安全时机读取 `HousingManager.Instance()->WorkshopTerritory`。
2. 生成规范化 `SubmarineSnapshot[]`：`{ slotIndex, name, rank, returnAtUtc, routePoints[5], parts{...} }`。
3. 与上次成功上报的快照做 diff（按 `slotIndex`，比较 `returnAtUtc/name/rank/routePoints`）。
4. 有变化 → 进入 `PendingUpload` 队列 → 后台线程 `POST /api/v1/submarines/sync`。
5. 成功：记录 `lastUploadAt`、清空对应待传项；失败：指数退避、保留待传项。

### 2.2 云端处理（入站）

```
POST /api/v1/submarines/sync
  → 认证（Bearer token → userId）
  → 校验 payload（时区 UTC、时间范围、字段类型、数量上限）
  → 事务：upsert submarines（按 user_id + character_id + slot_index）
          → 对每条"返航时间变化"的潜艇：取消旧批次成员资格，标记 needs_replan
  → 调用 scheduler-service.replan(userId)
  → 通知 DO：setAlarm(下次到期时间)
  → 返回统一 JSON { ok, data: { accepted, serverTime } }
```

### 2.3 调度（DO Alarm）

```
Scheduler.alarm()
  → 读取持久化状态（DO storage）
  → 计算"截至 now 的所有到期动作"
       ① 提前通知（advanceAt <= now 且未发送）
       ② 正式返航通知（notifyAt <= now 且未发送）
       ③ 重试（nextRetryAt <= now）
  → 逐条执行（幂等键 = batchId + kind）
  → 写入 notification_logs
  → 计算下一次到期时间 setAlarm(next)；无任务 → deleteAlarm()
```

---

## 3. 关键设计决策

### 3.1 以绝对时间为中心

- 潜艇数据**只存 `return_at`（Unix 秒，UTC）**，永远不存"剩余秒数"。
- 客户端上报时附带 `collected_at`、`client_time_offset_ms`（可选）。
- 云端在接收时用 `return_at` 与服务器时间做合理性校验：
  - `return_at` 不得早于 `now - 7d`（太久远 → 视为无效/已过期数据）
  - 不得晚于 `now + 8d`（潜艇最长航程 < 7 天；超出判定为异常）
  - 越界时**不覆盖已有值**，返回 `200` + `warnings[]`，并记录日志（不中断游戏端）。

### 3.2 通知合并（锚点 + 非链式）

依据 TODO §5 规则，算法用**纯函数**实现以便测试：

```ts
interface MergeInput { submarineId: string; returnAt: number; }   // 未通知的返航事件
interface Batch { items: MergeInput[]; anchorReturnAt: number; latestReturnAt: number; notifyAt: number; }

function buildBatches(events, windowSeconds): Batch[]
  // 1. 按 returnAt 升序
  // 2. anchor = 当前未消费事件的最早 returnAt
  // 3. 依次吸收 returnAt - anchor <= windowSeconds 的事件
  // 4. 一旦超出窗口：关闭当前批次，以该事件为新 anchor 开新批次
  // 5. notifyAt = batch.latestReturnAt
```

关键性质（会被测试锁定）：
- 例 1 `14:20,14:29,14:38, w=10m` → A={20,29}, B={38}
- 例 2 `14:20,14:25,14:29, w=10m` → A={20,25,29}, notifyAt=14:29
- 例 3 `14:20,14:31, w=10m` → A={20}, B={31}
- **非链式**：14:20、14:29 同批后，14:38 不会因"与 14:29 相差 9 分钟"而并入 A（锚点始终是该批最早的 14:20）。

### 3.3 提前通知

- `advance_notification_minutes ∈ {0,1,5,10,15,30}`（0 = 仅正式通知）。
- `advanceAt = latestReturnAt - advance*60`。
- 若 `advanceAt <= now` 且批次尚未正式通知 → 立即发送（标记 `advance_sent`），**不再重复**。
- 提前通知与正式通知使用同一 `batch_id`，但 `event_type ∈ {advance, returned}` 不同，幂等键不同。

### 3.4 批量重算（不破坏历史）

- 批次记录单独保存 `status ∈ {pending, sent, cancelled}`。
- 重算只操作 `status = 'pending'` 的批次：解散后按当前事件集合重新合并。
- `sent` 批次永久保留（用于去重与审计），其成员事件不再参与后续合并——
  避免"已通知过的返航时间被再次合并发送"。
- 成员与批次的关系表 `notification_batch_items` 带 `batch_id + submarine_id` 唯一约束。

### 3.5 幂等

| 场景 | 机制 |
|---|---|
| Worker 重复请求（同一 sync 内容） | 内容哈希 `payload_hash`，7 天内相同 → 直接返回接受，不重复处理 |
| 插件重复上传 | 同上 + 客户端本地 `lastUploadedHash` 短路 |
| Alarm 重复触发 | 发送前在 D1 用 `INSERT OR IGNORE` 写 `notification_logs(event_key UNIQUE)`，插入失败即视为已发送 |
| 推送成功但响应丢失 | 先写 `sending` 状态（带事件键），再调推送；失败重试以事件键判重 |
| 失败重试 | `attempt_count` 封顶 5，退避 `1,2,4,8,16` 分钟（可配），超过 → `failed` 并结束 |

### 3.6 时区

- 数据库全部 `INTEGER` Unix 秒（UTC）。
- 插件 UI 与通知文本按**用户配置时区**（默认系统时区）格式化，时区仅用于显示。
- `user_settings.timezone`（IANA 名称，如 `Asia/Shanghai`）用于通知正文的时间展示；缺失时按 UTC+8 显示并标注。

---

## 4. 模块划分

### 4.1 云端

| 模块 | 职责 |
|---|---|
| `routes/auth.ts` | 注册、设备绑定、token 轮换/吊销、账号删除 |
| `routes/submarine.ts` | sync、list、remove、refresh |
| `routes/settings.ts` | 读写用户设置 |
| `routes/push.ts` | 测试推送 + 立即发送下次返航（Bark/ntfy 统一入口） |
| `services/submarine-service.ts` | 校验 + 事务写入 + 触发重规划 |
| `services/notification-service.ts` | 合并算法 + 批次生成/重算 + 到期动作计算 |
| `services/scheduler-service.ts` | DO 调用封装（ensure alarm / replan / 状态查询） |
| `services/push/*` | `PushProvider` 接口 + `BarkProvider` / `NtfyProvider` |
| `storage/repository.ts` | 全部 D1 SQL（参数化）、事务辅助 |
| `durable-objects/scheduler.ts` | 每用户 Scheduler DO |
| `utils/*` | 时间、HMAC/哈希、校验、随机 ID |

### 4.2 插件

| 模块 | 职责 |
|---|---|
| `Plugin.cs` | 生命周期、事件订阅、命令 |
| `Configuration.cs` | Dalamud 配置（apiBase/apiToken/userId/deviceId/push 显示项/窗口等） |
| `ConfigurationWindow.cs` | 状态与配置 UI |
| `Submarine/SubmarineProvider.cs` | `unsafe` 读取工坊数据（唯一允许访问内存的类） |
| `Submarine/SubmarineScanner.cs` | 触发时机、节流、快照 diff、状态机 |
| `Submarine/ReturnTimeCalculator.cs` | 合理性校验、剩余时间、可选预测 |
| `Cloud/CloudClient.cs` | HTTP 客户端（超时、重试、脱敏日志） |
| `Cloud/CloudUploader.cs` | 待传队列、指数退避、持久化恢复 |
| `Storage/LocalCache.cs` | 本地 JSON 缓存（快照/队列/统计） |
| `Utilities/Clock.cs`, `Utilities/Logger.cs` | 可注入时钟（可测）、脱敏日志 |

---

## 5. 状态机

### 5.1 潜水艇（云端记录）

```
unknown ──sync(return_at>0)──► sailing ──到达 return_at──► returned
   ▲                              │                          │
   └────── 被移除/失效 ◄──────────┘                          │
                                                             ▼
                                                    (等待重新出航的 sync)
```

- `sailing`：`return_at > now`
- `returned`：`return_at <= now`（通知已排定/已发）
- `docked`：`return_at = 0`（客户端报告无航行）
- 状态只用于展示与筛选，**不影响通知调度**（调度只看 `return_at`）。

### 5.2 通知批次

```
pending ──(到期且成功)──► sent
   │
   ├──(成员变化/配置变化)──► 重算 → pending（新 id）
   └──(全部事件被取消)────► cancelled
```

### 5.3 DO Alarm

```
idle ──(有到期动作)──► armed ──alarm()──► 执行 ──► armed | idle
```

---

## 6. 错误处理策略

| 层 | 策略 |
|---|---|
| 插件读取内存 | `try/catch` + 指针空检查；失败不进上传队列，退避并记录；**绝不抛出到游戏主线程** |
| 插件 HTTP | 超时 15s；5xx/网络错误重试；4xx（除 429）不重试并提示用户 |
| Worker 校验 | 统一 `{ ok:false, error:{ code, message } }`；HTTP 400/401/403/404/409/429/500 |
| 推送 | 分类：`4xx`(非 429) → 永久失败；`429/5xx/网络` → 重试；每次失败记录 `error_message`（不含 device key） |
| DO | 状态先落库再执行；异常捕获后重排 alarm（`now + 60s`），避免卡死 |
| D1 | 事务包装，失败回滚；唯一约束兜底去重 |

---

## 7. 安全设计摘要（详见 `SECURITY.md`）

1. Token：`srk_` + 32 字节 CSPRNG（base64url），DB 只存 `SHA-256(token)` + 前缀（用于 UI 识别）。
2. 所有数据查询以 `user_id` 为第一条件，禁止跨用户读取。
3. `bark_device_key` / ntfy `token` 加密存储（AES-GCM，密钥来自 Worker secret `SECRETS_KEY`），**API 永不返回明文**；仅允许"已配置/未配置"布尔与掩码。
4. 上传接口限流：按 userId 60 次/分钟 + 按 IP 120 次/分钟（D1 计数表 + 滑动窗口）。
5. 所有 SQL 参数化；所有外部输入做长度/类型/范围校验。
6. 日志中不出现 token、device key、完整 payload。

---

## 8. 失败模式与对应设计

| 失败模式 | 设计回应 |
|---|---|
| 玩家关闭游戏 | 返航时间已入 D1，DO alarm 独立运行 |
| 玩家长期不登录 | 到点照发通知；后续 sync 覆盖旧数据 |
| DO 重启 | 状态全部在 DO storage + D1，alarm 自动恢复 |
| Alarm 迟到 | 执行时按"now"处理所有到期动作，不依赖精确时刻 |
| 返航时间被改早 | 重算 pending 批次；若 notifyAt 已过 → 立即发送 |
| 返航时间被改晚 | 重算；已发送的不撤回 |
| 推送服务不可用 | 指数退避，5 次后记 failed，不静默丢弃 |
| 用户删除账号 | 级联删除 D1 全部数据 + 关闭 DO + 清 alarm |

---

## 9. 目录结构

```
SubmarineNotifier/
├── cloud/
│   ├── src/{index.ts,routes/,services/,storage/,models/,durable-objects/,utils/}
│   ├── migrations/0001_initial.sql
│   ├── tests/
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── src/SubmarineReturnNotifier.Plugin/
│   ├── Plugin.cs, Configuration.cs, ConfigurationWindow.cs
│   ├── Submarine/, Cloud/, Notification/, Storage/, Utilities/
│   └── SubmarineReturnNotifier.Plugin.csproj
├── docs/
│   ├── RESEARCH.md, ARCHITECTURE.md, DATABASE.md, API.md
│   ├── DEPLOYMENT.md, SECURITY.md, TROUBLESHOOTING.md, USER_GUIDE.md
├── .research/   （证据脚本，非发布物）
└── .tooling/    （本地 Node 22 / .NET 8，非发布物）
```
