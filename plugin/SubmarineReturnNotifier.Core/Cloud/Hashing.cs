using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SubmarineReturnNotifier.Core.Cloud;

/// <summary>用于内容去重的稳定哈希（避免把同一份数据重复上传）。</summary>
public static class Hashing
{
    public static string Sha256Hex(string value)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    /// <summary>
    /// 对同步请求做内容哈希。只包含影响云端排程的字段；
    /// CollectedAt / ClientTimeOffsetMs 属于"采集时刻"，不参与去重，
    /// 否则每次扫描都会被视为新内容。
    /// </summary>
    public static string HashSyncRequest(SyncRequestDto request)
    {
        var normalized = new
        {
            request.CharacterId,
            request.WorldId,
            submarines = request.Submarines
                .OrderBy(s => s.SlotIndex)
                .Select(s => new { s.SlotIndex, s.Name, s.Rank, s.ReturnAt, s.RoutePoints, s.Parts })
                .ToArray(),
        };
        return Sha256Hex(JsonSerializer.Serialize(normalized));
    }
}
