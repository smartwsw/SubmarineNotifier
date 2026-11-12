using System.Globalization;
using System.Text;
using Dalamud.Plugin.Services;
using SubmarineReturnNotifier.Utilities;
using FFXIVClientStructs.FFXIV.Client.Game;
using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Submarine;

/// <summary>
/// 读取当前角色工坊中的潜水艇数据。
///
/// 数据来源（公开 API，已由 RESEARCH.md 核实）：
///   HousingManager.Instance()->WorkshopTerritory->Submersible
/// 其中 <c>ReturnTime</c> 是服务器同步的绝对 Unix 时间（秒），0 表示无航行。
///
/// 限制：<c>WorkshopTerritory</c> 只在客户端已加载工坊数据时非空，
/// 因此本类返回 <c>WorkshopLoaded=false</c> 时调用方必须跳过上传（保留上一次缓存）。
///
/// Dalamud API 15 起，<c>IClientState</c> 不再提供 <c>LocalPlayer</c> / <c>LocalContentId</c>，
/// 角色信息改由 <see cref="IPlayerState"/> 提供（见 docs/RESEARCH.md 的 API 15 核对记录）。
/// </summary>
public sealed class SubmarineProvider
{
    private const int MaxSlots = 4;
    private const int NameByteLength = 20;
    private const int ExplorationPointCount = 5;

    private readonly IClientState _clientState;
    private readonly IPlayerState _playerState;
    private readonly Logger _log;

    public SubmarineProvider(IClientState clientState, IPlayerState playerState, Logger log)
    {
        _clientState = clientState;
        _playerState = playerState;
        _log = log;
    }

    /// <summary>未登录 / 工坊未加载 / 角色信息缺失时返回 null。</summary>
    public unsafe ScanResult? TryScan()
    {
        if (!_clientState.IsLoggedIn) return null;
        if (!_playerState.IsLoaded) return null;

        var contentId = _playerState.ContentId;
        if (contentId == 0) return null;

        // 云端要求 1-20 位十进制数字（见 cloud/src/utils/validation.ts），
        // 因此使用 ContentId 的十进制表示，而不是十六进制。
        var characterId = contentId.ToString(CultureInfo.InvariantCulture);
        var characterName = _playerState.CharacterName;
        if (string.IsNullOrEmpty(characterName)) return null;

        uint currentWorld = _playerState.CurrentWorld.RowId;
        int? worldId = currentWorld == 0 ? null : (int)currentWorld;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();

        ScanResult NotLoaded() => new()
        {
            CharacterId = characterId,
            CharacterName = characterName,
            WorldId = worldId,
            CollectedAt = now,
            Submarines = Array.Empty<SubmarineSnapshot>(),
            WorkshopLoaded = false,
        };

        var housing = HousingManager.Instance();
        if (housing == null) return NotLoaded();

        var workshop = housing->WorkshopTerritory;
        if (workshop == null) return NotLoaded();

        var data = workshop->Submersible.Data;
        if (data.Length == 0) return NotLoaded();

        // 槽位数据尚未从服务器填充时 Name[0] 为 0；此时不认为工坊数据已就绪
        if (data[0].Name[0] == 0) return NotLoaded();

        var list = new List<SubmarineSnapshot>(MaxSlots);
        var count = Math.Min(MaxSlots, data.Length);
        for (var slot = 0; slot < count; slot++)
        {
            ref var item = ref data[slot];
            var name = ReadName(item.Name);
            if (string.IsNullOrEmpty(name)) continue;

            var returnAt = item.ReturnTime;
            list.Add(new SubmarineSnapshot
            {
                SlotIndex = slot,
                Name = name,
                Rank = item.RankId,
                ReturnAt = returnAt,
                State = MapState(returnAt, now),
                RoutePoints = ReadRoute(item.CurrentExplorationPoints),
                Parts = new Dictionary<string, int>(StringComparer.Ordinal)
                {
                    ["hull"] = item.HullId,
                    ["stern"] = item.SternId,
                    ["bow"] = item.BowId,
                    ["bridge"] = item.BridgeId,
                },
            });
        }

        _log.Debug($"[SubmarineReturnNotifier] 扫描到 {list.Count} 艘潜水艇（角色 {characterId}）");

        return new ScanResult
        {
            CharacterId = characterId,
            CharacterName = characterName,
            WorldId = worldId,
            CollectedAt = now,
            Submarines = list,
            WorkshopLoaded = true,
        };
    }

    private static unsafe string ReadName(Span<byte> raw)
    {
        var length = Math.Min(raw.Length, NameByteLength);
        var end = 0;
        while (end < length && raw[end] != 0) end++;
        if (end == 0) return string.Empty;
        return Encoding.UTF8.GetString(raw[..end]).Trim();
    }

    private static IReadOnlyList<int> ReadRoute(Span<byte> raw)
    {
        var points = new List<int>(ExplorationPointCount);
        var count = Math.Min(raw.Length, ExplorationPointCount);
        for (var i = 0; i < count; i++)
        {
            var point = raw[i];
            if (point == 0) continue; // 0 = 未使用
            points.Add(point);
        }
        return points;
    }

    private static SubmarineState MapState(uint returnTime, long nowUnix)
    {
        if (returnTime == 0) return SubmarineState.Docked;
        return returnTime > nowUnix ? SubmarineState.Sailing : SubmarineState.Returned;
    }
}
