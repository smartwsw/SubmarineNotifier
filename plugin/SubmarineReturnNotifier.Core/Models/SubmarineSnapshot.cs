namespace SubmarineReturnNotifier.Core.Models;

/// <summary>潜水艇状态。与云端 <c>state</c> 字段保持一致。</summary>
public enum SubmarineState
{
    Unknown = 0,
    Sailing = 1,
    Returned = 2,
    Docked = 3,
}

/// <summary>一艘潜水艇在某一时刻的快照（只包含从游戏中真实读取到的字段）。</summary>
public sealed record SubmarineSnapshot
{
    public required int SlotIndex { get; init; }
    public required string Name { get; init; }
    public required int Rank { get; init; }

    /// <summary>返航 Unix 时间（秒）。0 表示当前无航行。</summary>
    public required long ReturnAt { get; init; }

    public required SubmarineState State { get; init; }
    public required IReadOnlyList<int> RoutePoints { get; init; }
    public required IReadOnlyDictionary<string, int> Parts { get; init; }

    /// <summary>用于增量上传的变化检测；不参与展示。</summary>
    public string Fingerprint => string.Join(
        '|',
        SlotIndex,
        Name,
        Rank,
        ReturnAt,
        string.Join(',', RoutePoints),
        string.Join(',', Parts.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => $"{p.Key}={p.Value}")));

    public static SubmarineSnapshot Empty(int slotIndex) => new()
    {
        SlotIndex = slotIndex,
        Name = string.Empty,
        Rank = 0,
        ReturnAt = 0,
        State = SubmarineState.Unknown,
        RoutePoints = Array.Empty<int>(),
        Parts = new Dictionary<string, int>(),
    };
}

/// <summary>一次完整扫描结果。</summary>
public sealed record ScanResult
{
    public required string CharacterId { get; init; }
    public required string CharacterName { get; init; }
    public int? WorldId { get; init; }
    public required long CollectedAt { get; init; }
    public required IReadOnlyList<SubmarineSnapshot> Submarines { get; init; }

    /// <summary>工坊数据是否已在客户端加载。false 时 Submarines 为空且不应上传。</summary>
    public required bool WorkshopLoaded { get; init; }
}
