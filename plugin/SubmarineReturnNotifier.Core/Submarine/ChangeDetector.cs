using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Core.Submarine;

public enum ChangeKind
{
    None = 0,
    ReturnTimeChanged = 1,
    StateChanged = 2,
    Added = 3,
    Removed = 4,
    DetailsChanged = 5,
    CharacterChanged = 6,
}

public sealed record ChangeSummary
{
    public required ChangeKind Kind { get; init; }
    public required IReadOnlyList<string> Details { get; init; }

    public bool HasChanges => Kind != ChangeKind.None;

    public static ChangeSummary None { get; } = new() { Kind = ChangeKind.None, Details = Array.Empty<string>() };
}

/// <summary>
/// 比较前后两次扫描结果，决定是否需要上传。
///
/// 规则（对应 TODO §3 上传策略）：
///  - 角色变化 → 必须上传；
///  - 新增 / 消失的潜水艇 → 必须上传；
///  - 返航时间或状态变化 → 必须上传；
///  - 名称 / 等级 / 航点 / 部件变化 → 必须上传；
///  - 其它情况（完全相同）→ 不上传。
/// </summary>
public static class ChangeDetector
{
    public static ChangeSummary Compare(ScanResult? previous, ScanResult current)
    {
        if (previous is null)
        {
            return new ChangeSummary
            {
                Kind = ChangeKind.Added,
                Details = new[] { "首次扫描" },
            };
        }

        if (!string.Equals(previous.CharacterId, current.CharacterId, StringComparison.Ordinal))
        {
            return new ChangeSummary
            {
                Kind = ChangeKind.CharacterChanged,
                Details = new[] { $"{previous.CharacterId} -> {current.CharacterId}" },
            };
        }

        var details = new List<string>();
        var kind = ChangeKind.None;

        var before = previous.Submarines.ToDictionary(s => s.SlotIndex);
        var after = current.Submarines.ToDictionary(s => s.SlotIndex);

        foreach (var slot in after.Keys.OrderBy(k => k))
        {
            if (!before.TryGetValue(slot, out var old))
            {
                details.Add($"槽位 {slot} 新增");
                kind = Max(kind, ChangeKind.Added);
                continue;
            }

            var item = after[slot];
            if (old.ReturnAt != item.ReturnAt)
            {
                details.Add($"槽位 {slot} 返航时间 {old.ReturnAt} -> {item.ReturnAt}");
                kind = Max(kind, ChangeKind.ReturnTimeChanged);
            }

            if (old.State != item.State)
            {
                details.Add($"槽位 {slot} 状态 {old.State} -> {item.State}");
                kind = Max(kind, ChangeKind.StateChanged);
            }

            if (!string.Equals(old.Fingerprint, item.Fingerprint, StringComparison.Ordinal))
            {
                details.Add($"槽位 {slot} 信息变化");
                kind = Max(kind, ChangeKind.DetailsChanged);
            }
        }

        foreach (var slot in before.Keys.OrderBy(k => k))
        {
            if (!after.ContainsKey(slot))
            {
                details.Add($"槽位 {slot} 消失");
                kind = Max(kind, ChangeKind.Removed);
            }
        }

        return new ChangeSummary { Kind = kind, Details = details };
    }

    // 多个变化同时发生时，报告最能说明问题的那一个。
    // 顺序与枚举数值无关：返航时间/状态变化比笼统的"信息变化"更具体。
    private static int Priority(ChangeKind kind) => kind switch
    {
        ChangeKind.CharacterChanged => 6,
        ChangeKind.ReturnTimeChanged => 5,
        ChangeKind.StateChanged => 4,
        ChangeKind.Added => 3,
        ChangeKind.Removed => 2,
        ChangeKind.DetailsChanged => 1,
        _ => 0,
    };

    private static ChangeKind Max(ChangeKind a, ChangeKind b) => Priority(a) >= Priority(b) ? a : b;
}
