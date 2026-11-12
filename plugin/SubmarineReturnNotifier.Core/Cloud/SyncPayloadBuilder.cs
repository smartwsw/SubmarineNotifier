using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Core.Cloud;

/// <summary>把扫描结果转换为云端同步请求（纯函数，便于测试）。</summary>
public static class SyncPayloadBuilder
{
    public static SyncRequestDto Build(ScanResult scan, long clientNowUnix, int clientTimeOffsetMs = 0)
    {
        return new SyncRequestDto
        {
            CharacterId = scan.CharacterId,
            CharacterName = scan.CharacterName,
            WorldId = scan.WorldId,
            CollectedAt = scan.CollectedAt,
            ClientTimeOffsetMs = clientTimeOffsetMs,
            Submarines = scan.Submarines
                .Where(s => s.SlotIndex >= 0 && s.SlotIndex < ReturnTimeCalculatorLimit)
                .OrderBy(s => s.SlotIndex)
                .Select(s => new SyncSubmarineDto
                {
                    SlotIndex = s.SlotIndex,
                    Name = s.Name,
                    Rank = s.Rank,
                    ReturnAt = s.ReturnAt,
                    RoutePoints = s.RoutePoints,
                    Parts = s.Parts,
                    State = ToWireState(s.State),
                })
                .ToArray(),
        };
    }

    // 服务器最多接受 4 个槽位（见 cloud/src/utils/validation.ts）
    private const int ReturnTimeCalculatorLimit = 4;

    public static string ToWireState(SubmarineState state) => state switch
    {
        SubmarineState.Sailing => "sailing",
        SubmarineState.Returned => "returned",
        SubmarineState.Docked => "docked",
        _ => "unknown",
    };
}
