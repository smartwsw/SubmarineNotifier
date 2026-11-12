# RESEARCH — FF14 潜水艇返航数据获取技术调查

> 阶段：Phase 1（技术调查与验证），2026-11-12 按 API 15 复核
> 调查日期：2026-11-11（初版）、2026-11-12（API 15 适配）
> 调查对象：AutoRetainer（公开源码）、FFXIVClientStructs（Dalamud 内置版本 + AutoRetainer 附带版本）、Lumina.Excel、本地 Dalamud 安装
> 结论：**技术可行。返航时间可直接读取，无需自行推算。** API 15 下潜水艇字段无变化，仅角色信息入口与 ImGui 命名空间有改动（见 §6.4）。

---

## 1. 调查环境与证据基线

| 项目 | 值 | 证据来源 |
|---|---|---|
| 本地 Dalamud 版本（旧） | `11.0.5.1`（`AssemblyFileVersion`）/ `11.0.5.1+a690ccbe` | 反射读取 `%APPDATA%\XIVLauncher\addon\Hooks\dev\Dalamud.dll` |
| **目标 Dalamud 版本（API 15）** | **`15.0.4.0`** / `15.0.4.0+12e318c1` | `latest.zip`（<https://goatcorp.github.io/dalamud-distrib/latest.zip>）解包后反射读取 |
| 本地 FFXIVClientStructs | `0.0.5351+HEAD.7ba7ab4f` | `FFXIVClientStructs.dll` 版本信息 |
| 本地 Lumina.Excel | `7.1.3.0` | `Lumina.Excel.dll` 版本信息 |
| AutoRetainer 源码 | commit `cc020df0`，2026-08-27 | github.com/PunishXIV/AutoRetainer |
| AutoRetainer 附带 FFXIVClientStructs | commit `0769d1f1`，2025-11-19 | submodule |
| Dalamud 当前 release | `14.0.4.0`（2026-03-10），master 版本号 `15.0.3.9` | GitHub API `goatcorp/Dalamud` |
| Dalamud.NET.Sdk 最新 | `15.0.0`（NuGet 有 `9.0.0 … 15.0.0`） | nuget.org flat container |

> 说明：本机安装的 Dalamud 仍是 2025-01 的 API 11 版本，但**项目已按 API 15 构建**——编译时通过 `DALAMUD_HOME` 指向 15.0.4.0 的程序集目录。请以 XIVLauncher 安装的 Dalamud 版本为准；若客户端仍是 API 11，插件清单的 `DalamudApiLevel` 需相应调整。
> 本文档所述潜水艇数据字段在本地 API 11 程序集、API 15 程序集与 AutoRetainer 2026-08 源码三侧均已核对一致。

---

## 2. AutoRetainer 相关源码与用途

| 文件 | 用途 | 本项目是否复用 |
|---|---|---|
| `AutoRetainer/Modules/Voyage/VoyageUtils.cs` | 核心：从 `WorkshopTerritory` 读取潜水艇列表、名称、等级、返航时间、部件、航点；判断"无航行"（`ReturnTime == 0`） | 读取思路参考，代码独立实现 |
| `AutoRetainer/Modules/Voyage/VoyageUtils.cs:324-395` (`WriteOfflineData`) | 遍历 `Submersible.DataPointers[0..3]`，`Name.Read()`、`ReturnTime`、`RankId`、`CurrentExplorationPoints` | **是**（字段选择直接参考） |
| `AutoRetainer/Modules/Voyage/VoyageUtils.cs:304-307` (`GetRemainingSeconds`) | `ReturnTime - 当前Unix秒` | 是（公式一致） |
| `AutoRetainer/Modules/Voyage/VoyageCalculator/CurrentSubmarine.cs` | 读取当前选中的潜水艇（`DataPointers[4]`） | 否（本项目无需选中项） |
| `AutoRetainer/Modules/Voyage/VoyageCalculator/Voyage.cs` | 航程时长计算：`FixedVoyageTime = 43200` 秒（12h）+ 各航段航行时间 + 调查时间 | 仅用于**校验**与**预测**，不作为主数据源 |
| `AutoRetainer/Modules/Voyage/VoyageCalculator/SubmarineExplorationPretty.cs` | 公式：航行 `floor(dist*3990/(speed*100)*60)`；调查 `floor(SurveyDurationmin*7000/(speed*100)*60)` | 是（用于 TTL 合理性校验、可选预测） |
| `AutoRetainer/Modules/Voyage/VoyageCalculator/Sectors.cs` | 各海图属性阈值（来自社区表格），与返航时间无关 | 否 |
| `AutoRetainer/UI/MainWindow/WorkshopUI.cs:444-470` | 状态判定：`ReturnTime == 0` → "No voyage"；否则显示剩余时间 | 是（状态判定语义） |
| `AutoRetainer/UI/NeoUI/AdvancedEntries/DebugSection/DebugVoyage.cs:123-140` | 直接打印 `ReturnTime` / `GetReturnTime()` 的调试入口 | 用于验证方式参考 |

### 禁止依赖项确认
本项目**不引用** AutoRetainer 程序集、IPC、反射或私有成员；不读取/修改游戏内存。下文所有字段均来自公开的 FFXIVClientStructs（Dalamud 官方内置）和 Lumina.Excel（Dalamud 官方内置）的**公开 API**，AutoRetainer 仅作为"这些字段确实可用"的旁证。

---

## 3. 可用的 Dalamud / 游戏数据结构

### 3.1 潜水艇数据来源链

```
Dalamud 内置 FFXIVClientStructs:
HousingManager.Instance()                      // 单例指针（StaticAddress）
  └─ WorkshopTerritory*                        // 非 null 表示当前客户端已加载工坊（含潜水艇）数据
       └─ HousingWorkshopSubmersibleData Submersible
            ├─ Data        : FixedSizeArray4<HousingWorkshopSubmersibleSubData>   // 内联 4 条
            └─ DataPointers: FixedSizeArray5<Pointer<...>>                        // [0..3] 指向上面 4 条，[4] 为当前选中
```

字段（已在本地 `FFXIVClientStructs.dll` 反射核对，名称与 AutoRetainer 附带源码一致）：

`HousingWorkshopSubmersibleSubData`：

| 字段 | 类型 | 含义 |
|---|---|---|
| `ReturnTime` | `uint` | **返航 Unix 时间（秒，UTC）**；`0` 表示当前无航行 |
| `RegisterTime` | `uint` | 出发 Unix 时间（秒） |
| `RankId` | `byte` | 等级 |
| `CurrentExp` / `NextLevelExp` | `uint` | 经验 |
| `Name` | `Span<byte>`（UTF-8，20 字节） | 潜水艇名称，空名表示空槽位 |
| `CurrentExplorationPoints` | `Span<byte>[5]` | 当前航线的 5 个航点 ID（`0` 为未使用） |
| `HullId/SternId/BowId/BridgeId` | `ushort` | 部件（`SubmarinePart` 行 ID） |
| `SubmarineRating` | `enum byte` | 本次评价 SS~C |

`HousingManager` 上还有**游戏自身的航程计算函数**（已确认存在于本地程序集）：

```
GetSubmarineVoyageTime(byte pointA, byte pointB, short speed) -> uint
GetSubmarineSurveyDuration(byte point, short speed)          -> uint
GetSubmarineVoyageDistance(byte pointA, byte pointB)         -> uint
IsSubmarineExplorationUnlocked(byte point) / IsSubmarineExplorationExplored(byte point)
```

### 3.2 Lumina.Excel 表

`SubmarineExploration`（已反射核对字段）：

```
RowId(uint) Destination(SeString) Location(SeString) ExpReward(uint)
SurveyDurationmin(ushort) X/Y/Z(short) Map(RowRef<SubmarineMap>)
Stars(byte) RankReq(byte) CeruleumTankReq(byte) SurveyDistance(byte) StartingPoint(bool)
```

`SubmarineMap`：`RowId`, `Name(SeString)`, `Image(uint)`。

**结论**：航点名称、坐标、调查时长全部可从官方表读取，无需硬编码；`Map` 指向的海图行可给出"海域名称"。

---

## 4. 返航时间的实际获取方式

### 4.1 直接读取（主方案）

`HousingWorkshopSubmersibleSubData.ReturnTime` 就是游戏客户端内存中**已由服务器同步好的绝对返航时间**，单位 Unix 秒。AutoRetainer 全程直接使用该字段（`VoyageUtils.cs:360` 存离线数据、`WorkshopUI.cs:444` 计算进度条、`DebugVoyage.cs:140` 打印 `GetReturnTime()`），没有任何"从出发时间+航程推算"的路径。

因此本项目：
- **返航时间以 `ReturnTime` 为准**，客户端上传绝对时间戳（秒）。
- **不需要**自行按航速/坐标推算返航时间。
- 推算公式（§2 表）仅用于：
  1. 校验客户端上报时间是否合理（防止设备时钟错误导致荒谬值）；
  2. 在 UI 上显示"航程"参考。

### 4.2 状态下判定

| 状态 | 判定 |
|---|---|
| `Docked / 空闲` | `ReturnTime == 0`（AutoRetainer 语义：`No voyage`） |
| `Sailing / 航行中` | `ReturnTime > now` |
| `Returned / 已返航未收菜` | `ReturnTime <= now`（游戏内仍需进工坊"结算"，但通知时机已到） |
| `Empty slot` | `Name` 为空/全 0 |

> 注意：返航后到"重新出航"之间，`ReturnTime` 保持为过去的时刻，因此**已返航状态可由 `ReturnTime <= now` 稳定判定**。云端的通知计算不依赖这一字段，只依赖 `ReturnTime` 绝对值本身。

### 4.3 适用条件（关键限制）

`HousingManager.Instance()->WorkshopTerritory` **只在客户端已加载工坊数据时非空**。已确认：
- AutoRetainer 只在当前处于工坊/潜艇面板时写离线数据（`VoyageMain.cs:106-112` → `VoyageUtils.WriteOfflineData()`），并用 `WorkshopTerritory != null` 作为唯一门槛（`VoyageUtils.cs:327`）。
- `IsSubDataAvail()` 再加两道校验：`Data` 长度 > 0 且 `Data[0].Name[0] != 0`（`SubmarineUnlockPlanUI.cs:75-81`）。

**实际含义（本项目已并入设计）**：
1. 数据**不是**"任何时候都能读到"；玩家需要进过工坊（或潜艇面板）后数据才可用。
2. 插件应：登录/换区/换角色时尝试读取；`null` 时**不报错、不上传、不做猜测**，退避到下一周期；面板/工坊事件触发时立即补读。
3. 插件必须缓存最后一次成功读取的**绝对 ReturnTime**（见 §5 云端设计），即使关闭游戏，该时间仍然有效。

---

## 5. 技术可行性判定（逐项）

| TODO 要求验证项 | 结论 | 依据 |
|---|---|---|
| 获取当前角色潜水艇数量 | ✅ 可 | `DataPointers[0..3]` + 名称非空计数 |
| 识别各潜水艇状态 | ✅ 可 | `ReturnTime` 与 `now` 比较；空槽位按名称判 |
| 获取当前返航时间 | ✅ 可 | `ReturnTime`（Unix 秒） |
| 区分航行/待出航/已返航 | ✅ 可 | §4.2 |
| 区分不同潜水艇 | ✅ 可 | 名称（20 字节 UTF-8）+ 槽位索引 |
| 识别返航时间变化 | ✅ 可 | 逐槽位对比上次扫描（上传层做 diff） |
| 插件启动后恢复状态 | ✅ 可 | 本地持久化缓存 + 首次成功读取后补传 |
| 多角色 / 多账号 | ✅ 可 | `IPlayerState.ContentId`（角色）+ `CurrentWorld`；云端按 userId 隔离（API 15 起角色信息由 `IClientState` 迁到 `IPlayerState`，见 §6.4） |
| 关闭游戏后仍能推送 | ✅ 可 | 云端 Durable Object Alarm（与客户端无关） |

### 已知限制（必须写进用户文档与 TROUBLESHOOTING）

1. **仅当客户端加载过工坊数据后插件才能读到潜艇信息**；若玩家整天不进工坊，返航时间不会被刷新（但已上传的时间仍会照常触发通知）。
2. `ReturnTime` 由服务器同步，客户端系统时钟错误会影响"剩余时间"展示；上传值本身不依赖本机时钟，但 `collected_at` 会带上本机时钟，仅用于排序/合理性校验。
3. 潜水艇名称是玩家可改的；云端以 `(character_id, slot_index)` 作为稳定键，`name` 仅作展示。
4. 数据在游戏内有服务器延迟（进工坊后可能数秒才就绪），插件用 `delay` 重试而不是假定立即可用。
5. `WorkshopTerritory` 相关偏移属于 FFXIVClientStructs 维护范畴，**游戏大版本更新后需随 Dalamud 升级**；不在本项目内自行硬编码偏移。

---

## 6. 推荐的独立实现方案

### 6.1 客户端（Dalamud 插件）

```
SubmarineScanner
  ├─ 触发时机: 登录 / 换角色 / 换区 / 进入船坞相关 Addon / 每 N 秒（默认 60s，可配）
  ├─ unsafe 读取 HousingManager.Instance()->WorkshopTerritory
  │    ├─ null / Data[0].Name 为空 → 视为"数据未就绪"，不覆盖缓存
  │    └─ 逐槽位构建 SubmarineSnapshot
  │         { SlotIndex, Name, Rank, ReturnAtUtc, RoutePoints[], Parts[], CollectedAtUtc }
  ├─ 与上次快照 diff → 变化才进入上传队列
  └─ 数据来源单一化，UI 与上传共用同一快照
```

- **绝对时间直接上传**（不受云端重复计算），云端只做合理性校验。
- 本地缓存：`userId/deviceId/apiBase/characterId/lastSnapshot/pendingUploads/lastUploadAt/failures`。
- 上传失败：指数退避（1s→2s→4s…封顶 5min）+ 上限次数；失败数据**持久化**，重登恢复。
- 后台线程执行 HTTP（`Task.Run` + `HttpClient`），**绝不阻塞游戏主线程**，异常全部吞掉并记入本地日志。
- 敏感字段（apiToken）只存 Dalamud 配置目录，日志中脱敏。

### 6.2 云端（Cloudflare）

- D1 存 `users/devices/submarines/user_settings/notification_batches/notification_batch_items/notification_logs`。
- 每个用户一个 `Scheduler` Durable Object，`setAlarm()` 驱动提前通知 + 正式通知 + 重试；状态持久化在 DO storage。
- 批次合并：固定 anchor + 非链式窗口（TODO §5 规则）。
- `PushProvider` 抽象：`BarkProvider` / `NtfyProvider`。

### 6.3 构建方案

**当前状态：目标为 Dalamud API 15。**

| 项 | 值 |
|---|---|
| `Dalamud.NET.Sdk` | `15.0.0` |
| `TargetFramework` | `net10.0-windows`（由 SDK 的 `Sdk.props` 提供，项目文件不再覆盖） |
| `LangVersion` | `14.0`（同上） |
| 平台 | `x64`（同上） |
| 构建所用 SDK | .NET SDK **10.0.x** |
| 构建所用 Dalamud 程序集 | Dalamud **15.0.4.0**（`latest.zip`，API Level 15） |

- 引用通过 `Dalamud.NET.Sdk` 解析 `$(DALAMUD_HOME)`（若设置）或本机 `%APPDATA%\XIVLauncher\addon\Hooks\dev\`；不复制、不重分发 Dalamud 程序集。
- 核心逻辑工程 `SubmarineReturnNotifier.Core` 与测试工程仍为 `net8.0`，与 Dalamud 无关，可用任意 .NET 8+ SDK 构建和运行。
- 若把 SDK 升到更高版本，需同时确认 `TargetFramework` 与插件清单的 `DalamudApiLevel` 匹配；**以实际 build 通过为准**。

> 注意：API 15 的 SDK 要求 **.NET 10 SDK** 才能编译 `net10.0-windows` 目标。仅有 .NET 8 SDK 时会报 `NETSDK1045`。

### 6.4 API 11 → API 15 的适配记录

以下差异由 Mono.Cecil 反射实际程序集得到（不是推测），也是本次改动的依据：

| 项目 | API 11 | API 15 |
|---|---|---|
| 角色 ContentId | `IClientState.LocalContentId`（`ulong`） | **移除**；改用 `IPlayerState.ContentId`（`ulong`） |
| 本地玩家 | `IClientState.LocalPlayer` | **移除**；角色名改用 `IPlayerState.CharacterName`（`string`），世界用 `IPlayerState.CurrentWorld.RowId` |
| 角色是否就绪 | `IsLoggedIn` + `LocalPlayer != null` | 增加 `IPlayerState.IsLoaded` |
| `TerritoryChanged` | `Action<ushort>` | `Action<uint>` |
| ImGui 命名空间 | `ImGuiNET`（`ImGui.NET.dll`） | `Dalamud.Bindings.ImGui`（`Dalamud.Bindings.ImGui.dll`） |
| ImGui 字符串参数 | `string` | `ImU8String`（`string` 有 `op_Implicit`，调用处无需改动） |
| `TextColored` | `Vector4` 按值 | `in Vector4&`（调用语法不变） |
| `CommandInfo` | 可在对象初始化器里设 `HelpMessage` | 属性可写，构造仍为 `new CommandInfo(handler)`；用法不变 |
| `HousingManager` / `WorkshopTerritory` / `HousingWorkshopSubmersibleSubData` | — | **字段与属性无变化**：`WorkshopTerritory->Submersible.Data`（`Span<HousingWorkshopSubmersibleSubData>`）、`ReturnTime`（`uint`）、`Name`（`Span<byte>`）、`RankId`（`byte`）、`CurrentExplorationPoints`（`Span<byte>`）、`HullId/SternId/BowId/BridgeId`（`ushort`）均保持一致 |

结论：潜水艇读取逻辑本身无需改动，改的只是"从哪里拿角色信息"和 ImGui 的命名空间。

---

## 7. 需要进一步验证的事项（Phase 4/5 实测）

| # | 事项 | 验证方式 |
|---|---|---|
| 1 | 真实游戏内 `ReturnTime` 与游戏 UI 显示一致 | 进工坊截图对比插件显示；Debug 页显示原始 Unix 值 |
| 2 | `WorkshopTerritory` 在非工坊区域/AFK 时是否仍非空 | 登录后静置、出工坊后观测；记录 `null` 出现条件 |
| 3 | 面板关闭后数据是否继续刷新 | 部署后对比 `CollectedAt` |
| 4 | 空槽位名称判定 | 在只有 1~2 条潜艇的低等级 FC 验证 |
| 5 | 当前 Dalamud API（11/14/15）下 `HousingWorkshopSubmersibleSubData` 字段偏移 | 用 `Dal` 内置 FFXIVClientStructs 反射一次 `StructSize`/偏移，构建时断言 |
| 6 | 重启游戏/重登后 `ReturnTime` 的服务器同步延迟 | 重登后 0/5/10/30s 轮询记录 |
| 7 | DO Alarm 最小时延与批量合并的时区行为 | Wrangler 本地 + 云端 `wrangler tail` |

---

## 8. 结论

1. **返航时间可直接读取**（`uint ReturnTime`，Unix 秒），无需推算，无需依赖 AutoRetainer。
2. 状态（航行/已返航/空槽）可由 `ReturnTime` 与名称稳定判定。
3. 唯一的硬性限制是"需客户端加载过工坊数据"；这可通过"每次可读即上传绝对时间 + 云端持久化调度"完全规避——**关闭游戏后通知照常触发**。
4. 所有字段均有本地 Dalamud 程序集与公开源码双重证据，无编造 API。
5. Phase 2 可按 TODO 的架构直接推进，无需修改总体设计；只需在插件中显式处理"数据未就绪"场景。

---

## 附：证据命令（可复现）

```powershell
# 核对本地程序集里真实的字段与接口（证据脚本随仓库放在 .research/）
powershell -File .research/DumpApi.ps1
powershell -File .research/DumpDalamudApi.ps1
```

```bash
# 核对 AutoRetainer 读取逻辑
#   VoyageUtils.cs:324-395  WriteOfflineData（Submersible.DataPointers）
#   VoyageUtils.cs:304-307  GetRemainingSeconds = ReturnTime - now
#   WorkshopUI.cs:444-470   ReturnTime == 0 => "No voyage"
#   WorkshopTerritory.cs:14,32-35,97-98  Submersible / Data / DataPointers / ReturnTime
```
