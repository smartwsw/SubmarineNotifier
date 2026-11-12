# FF14 潜水艇返航 Bark 推送系统——Codex 项目实施提示词

你是一名熟悉 FF14、Dalamud 插件开发、C#、Cloudflare Workers、D1、Durable Objects、TypeScript、Bark 推送的高级开发工程师。

请在当前工作区中，设计并实现一套完整的 FF14 潜水艇返航通知系统。

项目目标是：**玩家在线时由 Dalamud 插件读取潜水艇返航信息并上传至 Cloudflare，玩家下线或关闭电脑后，由 Cloudflare 自动计算返航时间、合并通知并通过 Bark 推送。**

请严格按照以下要求执行。

---

## 一、项目总体架构

采用以下技术方案：

### 客户端
- C#
- Dalamud 插件
- 使用 Dalamud 官方 SDK
- 最终以 DLL 插件形式发布
- 不要求普通用户安装 Node.js
- 不要求普通用户运行独立服务

### 云端
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Durable Objects
- Durable Objects Alarm
- TypeScript
- Wrangler
- Vitest

### 推送
- Bark HTTP API
- 支持自定义 Bark Server URL
- 支持自定义 Bark Device Key
- 支持通知标题、正文、分组、图标、声音等配置

### 架构原则

1. 插件负责采集、上传和本地配置。
2. 云端负责持久化、返航时间计算、通知合并和调度。
3. 用户关闭游戏或电脑后，云端任务仍然继续运行。
4. Cloudflare 不依赖任何本地常驻程序。
5. 所有返航任务必须持久化，不能只存在于内存。
6. 所有通知操作必须支持幂等，避免重复发送。
7. 用户可以在多个角色或多个账号之间独立管理潜水艇。
8. 云端不能依赖游戏在线状态进行通知调度。

---

## 二、第一阶段：调查和技术验证

在编写正式代码之前，必须先调查以下内容。

### 1. 潜水艇信息获取

研究 AutoRetainer 的公开源代码，重点调查：

- 潜水艇状态读取方式
- 潜水艇等级和部件信息
- 当前航行状态
- 返航时间的获取或计算方式
- 潜水艇探索区域及航程数据
- 潜水艇任务状态识别
- 潜水艇返航时间计算所需的游戏数据

要求：

- 可以参考 AutoRetainer 的公开实现思路和公开数据。
- 不允许直接依赖 AutoRetainer。
- 不允许引用 AutoRetainer 的 IPC。
- 不允许引用 AutoRetainer 的程序集。
- 不允许通过反射调用 AutoRetainer 的内部实现。
- 不允许使用 AutoRetainer 私有接口。
- 不允许通过内存读取、内存修改或其他非正常方式获取游戏信息。
- 不允许编造 Dalamud API、游戏数据字段或潜水艇接口。

如果 AutoRetainer 使用某种特殊的数据读取方式，先分析该方式是否能够通过独立实现和合法的 Dalamud API 实现。

### 2. 验证 Dalamud 可获取性

必须实际验证：

- 是否可以获取当前角色的潜水艇数量。
- 是否可以识别各潜水艇当前状态。
- 是否可以获取当前返航时间。
- 是否可以识别潜水艇正在航行、等待出航、已返航等状态。
- 是否能够区分不同潜水艇。
- 是否能够识别返航时间发生变化。
- 是否能够在插件启动后恢复潜水艇状态。

如果无法直接获取返航时间，研究是否可以通过当前状态、任务信息和游戏数据独立计算。

### 3. 技术调查结果

首先生成：

`docs/RESEARCH.md`

包含：

- 相关 AutoRetainer 源码文件及其用途。
- 相关 Dalamud API。
- 可使用的游戏数据。
- 潜水艇返航时间的实际获取或计算方式。
- 技术可行性结论。
- 可能存在的限制。
- 推荐的独立实现方案。
- 需要进一步验证的事项。

**不得在尚未验证数据来源的情况下开始编写假定能够正常工作的潜水艇读取代码。**

---

## 三、Dalamud 插件设计

插件名称：

`SubmarineReturnNotifier`

建议命名空间：

`SubmarineReturnNotifier`

建议目录：

```text
src/
  SubmarineReturnNotifier.Plugin/
    Plugin.cs
    Configuration.cs
    ConfigurationWindow.cs

    Submarine/
      SubmarineProvider.cs
      SubmarineState.cs
      SubmarineScanner.cs
      ReturnTimeCalculator.cs

    Cloud/
      CloudClient.cs
      CloudModels.cs
      CloudUploader.cs

    Notification/
      NotificationPreview.cs

    Storage/
      LocalCache.cs

    Utilities/
      Clock.cs
      Logger.cs
```

### 1. 插件功能

提供一个配置界面，至少包括：

- Cloudflare Worker API 地址
- 用户注册或设备绑定
- 用户身份信息
- Bark 推送配置
- Bark Server URL
- Bark Device Key
- Bark 测试推送
- 上传状态
- 上次成功上传时间
- 当前角色信息
- 当前潜水艇状态
- 下次返航时间
- 云端连接状态
- 最近错误日志
- 手动刷新
- 手动上传

### 2. 潜水艇扫描

要求：

- 插件启动后扫描当前角色的潜水艇状态。
- 游戏状态变化时更新。
- 在适当的周期进行刷新。
- 不允许每帧执行大量数据读取。
- 不允许重复上传完全相同的数据。
- 支持游戏重新登录、切换角色、插件重新加载。
- 正确处理数据尚未加载、角色未登录和游戏退出等情况。

### 3. 上传策略

采用增量上传。

只有以下情况需要上传：

- 潜水艇返航时间发生变化。
- 潜水艇任务状态发生变化。
- 新发现潜水艇。
- 潜水艇信息被删除或失效。
- 用户手动刷新。
- 插件首次成功识别潜水艇状态。
- 云端需要重新同步。

上传失败时：

- 保存待上传数据。
- 采用指数退避重试。
- 允许游戏重新登录后恢复上传。
- 不得阻塞游戏主线程。
- 不得因为 Bark 或 Cloudflare 请求失败而影响游戏运行。

### 4. 本地缓存

需要持久化：

- 用户 ID
- 设备 ID
- Cloudflare API 地址
- 当前角色标识
- 潜水艇状态
- 待上传的数据
- 上次成功上传时间
- 上传失败状态

敏感数据必须避免明文输出到日志。

---

## 四、Cloudflare 云端设计

建议采用以下目录结构：

```text
cloud/
  src/
    index.ts

    routes/
      auth.ts
      submarine.ts
      settings.ts
      bark.ts

    services/
      submarine-service.ts
      notification-service.ts
      scheduler-service.ts
      bark-service.ts

    storage/
      repository.ts

    models/
      submarine.ts
      notification.ts
      user.ts

    durable-objects/
      scheduler.ts

    utils/
      crypto.ts
      validation.ts
      time.ts

  migrations/
    0001_initial.sql

  tests/
    auth.test.ts
    submarine.test.ts
    scheduler.test.ts
    notification.test.ts
    bark.test.ts

  wrangler.toml
  package.json
  tsconfig.json
  vitest.config.ts
```

可以根据实际实现调整目录，但必须保持模块职责清晰。

### 1. D1 数据库

至少设计以下数据表：

#### users

存储用户基本信息：

- id
- created_at
- updated_at
- status

#### devices

存储用户设备信息：

- id
- user_id
- device_name
- created_at
- last_seen_at
- status

#### submarines

存储潜水艇信息：

- id
- user_id
- character_id
- character_name
- submarine_id
- submarine_name
- state
- return_at
- last_uploaded_at
- updated_at

#### user_settings

存储用户配置：

- user_id
- merge_window_minutes
- advance_notification_minutes
- bark_server_url
- bark_device_key
- bark_sound
- bark_group
- bark_icon
- notification_enabled
- updated_at

#### notification_batches

存储通知批次：

- id
- user_id
- anchor_return_at
- latest_return_at
- notify_at
- status
- created_at
- updated_at
- sent_at

#### notification_batch_items

记录批次与潜水艇之间的关系：

- batch_id
- submarine_id
- return_at

#### notification_logs

记录通知执行情况：

- id
- user_id
- batch_id
- event_type
- status
- error_message
- created_at

具体字段类型、索引和外键根据实际设计确定。

要求：

- 编写 SQL Migration。
- 为查询字段建立合理索引。
- 所有数据库操作参数化。
- 不允许将用户输入直接拼接为 SQL。
- 提供数据库迁移和初始化说明。

---

## 五、返航时间和通知合并逻辑

这是整个系统最重要的部分。

### 1. 返航时间

所有返航时间统一使用 UTC 时间戳存储。

客户端可以上传：

- 当前潜水艇状态
- 返航时间
- 任务状态
- 数据采集时间
- 角色和潜水艇标识

如果客户端提供的是绝对返航时间，云端以客户端计算结果为准，但必须校验合理性。

如果客户端无法获取绝对返航时间，则需要根据已验证的游戏数据和规则计算。

云端不得凭空推算潜水艇返航时间。

### 2. 通知合并

用户可以配置：

`merge_window_minutes`

默认：

`10`

合并规则：

1. 找出所有尚未通知的返航事件。
2. 按返航时间从早到晚排序。
3. 最早返航时间作为固定 anchor。
4. 后续事件如果满足：

   `return_at - anchor_return_at <= merge_window`

   则加入当前批次。
5. 超出窗口则创建新的批次。
6. 当前批次的通知时间取其中最晚返航时间。
7. 批次成员发生变化时重新计算。
8. 已发送的批次不得再次发送。
9. 不允许使用链式合并。

示例：

```text
U1: 14:20
U2: 14:29
U3: 14:38

merge_window = 10 minutes
```

结果：

```text
Batch A:
  U1: 14:20
  U2: 14:29
  notify_at: 14:29

Batch B:
  U3: 14:38
  notify_at: 14:38
```

### 3. 提前通知

用户可以设置：

```text
10 minutes
5 minutes
1 minute
0 minutes
```

提前通知基于：

`batch.latest_return_at`

例如：

```text
Batch latest return: 14:29
Advance notification: 5 minutes

Notify at: 14:24
```

提前通知与返航通知需要分别记录状态，避免重复发送。

如果多个提前通知时间重叠，必须保证不会重复推送。

### 4. 批次重新计算

当发生以下情况时，需要重新计算未发送批次：

- 潜水艇返航时间变化。
- 潜水艇状态发生变化。
- 新增潜水艇。
- 潜水艇返航事件取消。
- 用户修改合并窗口。
- 用户修改提前通知时间。

重新计算不得影响已完成的通知记录。

---

## 六、Durable Objects Alarm 调度

使用 Durable Objects 实现可靠调度。

要求：

- 每个用户可以有独立 Scheduler Durable Object。
- Durable Object 保存用户调度状态。
- 使用 `setAlarm()` 设置下一次调度时间。
- 使用 `alarm()` 执行调度。
- 任务状态必须持久化。
- 每次执行后计算下一次任务时间。
- 没有待处理任务时清除 Alarm。
- 支持任务取消、重新排程和恢复。
- 不允许使用常驻 `setTimeout()` 或 `setInterval()` 实现云端长期调度。
- 不允许通过每分钟 Cron 扫描所有用户的方式作为主要调度方案。

Alarm 需要覆盖：

- 提前通知。
- 正式返航通知。
- 批次重新计算。
- 通知失败后的重试。

注意：

Durable Objects Alarm 是持久化调度机制，但实际触发时间可能存在一定延迟，不应假定精确到毫秒或保证绝对准点。

---

## 七、消息推送

## 推送服务抽象与多平台兼容

不要将通知系统直接绑定 Bark。

实现统一的 PushProvider 接口：

- BarkProvider：iOS Bark 推送
- NtfyProvider：Android ntfy 推送
- 后续允许扩展其他推送服务

### PushProvider 接口

统一实现：

- sendNotification()
- testNotification()
- validateConfiguration()
- getProviderName()

### 用户配置

每个用户可以独立设置：

- 推送服务类型
- 推送服务地址
- 推送 Token / Topic
- 通知标题
- 通知正文
- 通知分组
- 通知声音
- 通知图标
- 通知优先级

### BarkProvider

使用 Bark HTTP API。

支持：

- Server URL
- Device Key
- Group
- Sound
- Icon
- 测试推送

### NtfyProvider

使用 ntfy HTTP API。

支持：

- ntfy.sh 或自定义服务器
- Topic
- Access Token
- Title
- Priority
- Tags
- Click URL
- 测试推送

Topic 不应作为唯一认证手段，必须支持私有 Topic 或 Access Token。


## 八、用户认证和安全

实现轻量化用户注册与认证。

优先考虑：

- 用户随机 ID。
- 用户独立 API Token。
- 设备绑定。
- Token 轮换。
- Token 撤销。
- 用户删除。
- 设备删除。

要求：

- Token 只在创建时完整返回一次。
- 数据库只存储 Token 的哈希。
- Token 使用安全随机数生成。
- 请求使用 HTTPS。
- 对敏感接口实施认证。
- 对上传接口实施合理的频率限制。
- 不允许用户通过修改请求访问其他用户的数据。
- 所有接口必须校验用户身份。
- 不允许将 Bark Device Key 返回给插件。

不需要复杂的 OAuth 或第三方登录系统。

---

## 九、API 设计

至少实现：

```text
POST /api/v1/auth/register

POST /api/v1/auth/device

POST /api/v1/submarines/sync

GET  /api/v1/submarines

GET  /api/v1/status

GET  /api/v1/settings

PUT  /api/v1/settings

POST /api/v1/bark/test

DELETE /api/v1/account
```

可根据实际需要增加：

```text
POST /api/v1/submarines/remove
POST /api/v1/submarines/refresh
GET  /api/v1/notifications
GET  /api/v1/logs
```

要求：

- 所有接口使用统一 JSON 格式。
- 所有错误返回统一错误结构。
- 所有接口编写 TypeScript 类型。
- 接口文档必须完整。
- 插件与 Worker 共享一致的数据模型。

---

## 十、通知幂等和异常处理

必须考虑以下情况：

- Durable Objects Alarm 重复触发。
- Bark 请求成功但响应丢失。
- 网络超时。
- Bark Server 返回错误。
- Cloudflare Worker 重复请求。
- 插件重复上传。
- 用户修改返航时间。
- 用户删除潜水艇。
- 用户修改通知配置。
- 用户关闭通知。
- 用户删除账号。
- Cloudflare 数据库异常。
- Durable Objects 重启。
- 调度时间已经过期。
- 返航时间已过但仍未通知。
- 用户长时间没有登录游戏。

要求：

- 通知发送使用唯一事件 ID。
- 所有调度状态持久化。
- 不得因为 Alarm 重复执行而重复发送。
- 对失败请求采用有限次数指数退避。
- 超过重试次数后记录失败状态。
- 不允许无限重试。
- 不允许静默丢弃任务。
- 提供必要的错误日志和恢复机制。

---

## 十一、测试要求

必须编写自动化测试。

### 客户端测试

- 潜水艇状态识别。
- 返航时间变化检测。
- 重复数据过滤。
- 上传失败重试。
- 本地缓存恢复。
- 角色切换。
- 插件重新加载。

### 云端测试

- 用户注册。
- Token 认证。
- 用户隔离。
- 潜水艇同步。
- 返航时间更新。
- 批次合并。
- 固定锚点合并。
- 提前通知。
- 返航通知。
- 批次重排。
- 已发送通知去重。
- Alarm 调度。
- Bark 失败重试。
- Bark 测试推送。
- 删除用户。
- 删除潜水艇。

### 必须覆盖的合并测试

```text
U1 = 14:20
U2 = 14:29
U3 = 14:38

window = 10m

预期：

Batch A = U1 + U2
Batch B = U3
```

以及：

```text
U1 = 14:20
U2 = 14:25
U3 = 14:29

window = 10m

预期：

Batch A = U1 + U2 + U3
notify_at = 14:29
```

以及：

```text
U1 = 14:20
U2 = 14:31

window = 10m

预期：

Batch A = U1
Batch B = U2
```

---

## 十二、部署要求

必须提供完整 Cloudflare 部署流程。

包括：

- Wrangler 安装。
- Cloudflare 登录。
- 创建 D1。
- 创建 Durable Objects。
- 配置 Worker。
- 配置 Secrets。
- 数据库迁移。
- 本地开发。
- 本地测试。
- 远程部署。
- 查看日志。
- 更新版本。
- 回滚。
- 删除项目。

提供：

```text
cloud/wrangler.toml
cloud/package.json
cloud/tsconfig.json
cloud/vitest.config.ts
cloud/migrations/
```

要求：

- Wrangler 配置使用当前稳定版本支持的正确格式。
- Durable Objects migration 使用正确配置。
- 不编造 Cloudflare 配置字段。
- 不编造 CLI 参数。
- 如果 API 或配置存在版本差异，先查阅当前官方文档。

---

## 十三、DLL 发布要求

最终发布：

```text
SubmarineReturnNotifier.dll
```

要求：

- DLL 可直接作为 Dalamud 插件安装。
- 不要求普通用户安装 Node.js。
- 不要求普通用户运行 Worker。
- 不要求普通用户配置 Cloudflare。
- 不要求普通用户运行本地服务。
- 不要求用户安装额外数据库。
- 插件配置通过 Dalamud 配置系统保存。
- 所有必要依赖正确处理。
- 不允许将开发环境依赖打包进插件。
- 提供安装说明和卸载说明。

---

## 十四、项目文档

至少生成：

```text
README.md

docs/
  RESEARCH.md
  ARCHITECTURE.md
  DATABASE.md
  API.md
  DEPLOYMENT.md
  SECURITY.md
  TROUBLESHOOTING.md
  USER_GUIDE.md
```

README 必须说明：

- 项目用途。
- 系统架构。
- 插件安装方式。
- Cloudflare 部署方式。
- Bark 配置方式。
- 用户注册方式。
- 潜水艇返航通知机制。
- 费用及免费额度说明。
- 常见问题。
- 已知限制。

---

## 十五、开发执行流程

请按以下阶段执行，不要一次性生成大量未经验证的代码。

### Phase 1：技术调查

- 研究 AutoRetainer。
- 验证 Dalamud 潜水艇数据获取。
- 确定返航时间获取或计算方式。
- 生成 RESEARCH.md。
- 提交技术方案。

### Phase 2：架构设计

- 设计数据库。
- 设计 API。
- 设计通知合并算法。
- 设计 Alarm 调度。
- 设计认证机制。
- 生成 ARCHITECTURE.md 和 DATABASE.md。

### Phase 3：云端实现

- 创建 Worker。
- 创建 D1。
- 创建 Durable Objects。
- 实现 API。
- 实现通知调度。
- 实现 Bark。
- 编写测试。
- 通过所有测试。

### Phase 4：Dalamud 插件实现

- 实现独立 SubmarineProvider。
- 实现潜水艇扫描。
- 实现返航时间计算。
- 实现上传。
- 实现本地缓存。
- 实现配置界面。
- 实现错误处理。
- 实现测试推送。

### Phase 5：联调

- 本地 Worker 联调。
- 插件与 Worker 联调。
- 测试返航时间同步。
- 测试批次合并。
- 测试提前通知。
- 测试正式返航通知。
- 测试关闭游戏后的云端调度。
- 测试 Bark 失败恢复。

### Phase 6：发布

- 构建 Release DLL。
- 检查依赖。
- 检查日志泄露。
- 检查 API 安全。
- 检查数据库迁移。
- 检查部署流程。
- 生成最终用户安装文档。

---

## 十六、实施约束

整个开发过程必须遵守：

1. 不得编造 Dalamud API。
2. 不得编造游戏数据字段。
3. 不得假定 AutoRetainer 的内部接口公开可用。
4. 不得依赖 AutoRetainer。
5. 不得通过内存读取或修改获取潜水艇数据。
6. 不得使用不可靠的常驻定时器作为云端调度。
7. 不得将用户 Token 或 Bark Key 写入日志。
8. 不得将用户数据混合存储。
9. 不得跳过自动化测试。
10. 不得只生成代码而不提供部署文档。
11. 不得只生成架构示例而不实现实际功能。
12. 不得在没有真实验证的情况下宣称功能完成。
13. 所有技术方案必须以实际代码、官方文档或可验证的实现为依据。
14. 如果发现某项功能无法实现，必须明确说明原因、现有证据和可替代方案，而不是虚构实现。

---

## 十七、最终交付标准

项目完成时必须满足：

- Dalamud 插件可以独立运行。
- 可以识别潜水艇状态。
- 可以获取或计算真实返航时间。
- 可以向 Cloudflare 上传潜水艇信息。
- Cloudflare 可以保存并更新返航事件。
- 可以正确合并返航通知。
- 可以发送提前通知。
- 可以发送正式返航通知。
- 游戏关闭后通知仍可正常执行。
- Bark 推送正常。
- 通知失败可以恢复。
- 用户数据相互隔离。
- 插件配置能够持久化。
- Cloudflare 数据库迁移正常。
- 自动化测试全部通过。
- 可以构建 Release DLL。
- 可以按照文档独立部署 Cloudflare。
- 普通用户只需要安装 DLL 并配置账号和 Bark。

**现在开始执行 Phase 1。先检查当前工作区和相关公开源码，完成技术调查并生成 RESEARCH.md。不要跳过调查直接编写假定能够工作的潜水艇读取实现。完成一个阶段后，报告实际完成内容、测试结果、尚未解决的问题，再继续下一阶段。**