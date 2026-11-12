using System.Text.Json.Serialization;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Core.Storage;

/// <summary>
/// 本地缓存中持久化的"待上传"状态：包含最近一次扫描结果与重试元数据。
/// 不含任何密钥；云端 token 由独立字段保存。
/// </summary>
public sealed class PendingUpload
{
    [JsonPropertyName("characterId")] public string CharacterId { get; set; } = string.Empty;
    [JsonPropertyName("characterName")] public string CharacterName { get; set; } = string.Empty;
    [JsonPropertyName("worldId")] public int? WorldId { get; set; }
    [JsonPropertyName("collectedAt")] public long CollectedAt { get; set; }
    [JsonPropertyName("workshopLoaded")] public bool WorkshopLoaded { get; set; }
    [JsonPropertyName("submarines")] public List<SubmarineSnapshot> Submarines { get; set; } = new();

    [JsonPropertyName("attempts")] public int Attempts { get; set; }
    [JsonPropertyName("nextAttemptAt")] public DateTimeOffset? NextAttemptAt { get; set; }
    [JsonPropertyName("lastError")] public string? LastError { get; set; }
    [JsonPropertyName("lastSuccessAt")] public DateTimeOffset? LastSuccessAt { get; set; }
    [JsonPropertyName("lastPayloadHash")] public string? LastPayloadHash { get; set; }

    [JsonIgnore]
    public bool HasPending => CharacterId.Length > 0 && WorkshopLoaded;

    public static PendingUpload FromScan(ScanResult scan) => new()
    {
        CharacterId = scan.CharacterId,
        CharacterName = scan.CharacterName,
        WorldId = scan.WorldId,
        CollectedAt = scan.CollectedAt,
        WorkshopLoaded = scan.WorkshopLoaded,
        Submarines = scan.Submarines.ToList(),
    };

    public ScanResult ToScanResult() => new()
    {
        CharacterId = CharacterId,
        CharacterName = CharacterName,
        WorldId = WorldId,
        CollectedAt = CollectedAt,
        WorkshopLoaded = WorkshopLoaded,
        Submarines = Submarines,
    };

    public SyncRequestDto ToRequest(long clientNowUnix, int clientTimeOffsetMs = 0) =>
        SyncPayloadBuilder.Build(ToScanResult(), clientNowUnix, clientTimeOffsetMs);
}
