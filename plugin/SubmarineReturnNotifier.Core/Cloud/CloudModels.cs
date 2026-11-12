using System.Text.Json.Serialization;

namespace SubmarineReturnNotifier.Core.Cloud;

// 与 cloud/src/models/index.ts 的 wire DTO 一一对应（camelCase）。

public sealed record SyncSubmarineDto
{
    [JsonPropertyName("slotIndex")] public int SlotIndex { get; init; }
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("rank")] public int Rank { get; init; }
    [JsonPropertyName("returnAt")] public long ReturnAt { get; init; }
    [JsonPropertyName("routePoints")] public IReadOnlyList<int> RoutePoints { get; init; } = Array.Empty<int>();
    [JsonPropertyName("parts")] public IReadOnlyDictionary<string, int> Parts { get; init; } = new Dictionary<string, int>();
    [JsonPropertyName("state")] public string State { get; init; } = "unknown";
}

public sealed record SyncRequestDto
{
    [JsonPropertyName("characterId")] public string CharacterId { get; init; } = string.Empty;
    [JsonPropertyName("characterName")] public string CharacterName { get; init; } = string.Empty;
    [JsonPropertyName("worldId")] public int? WorldId { get; init; }
    [JsonPropertyName("collectedAt")] public long CollectedAt { get; init; }
    [JsonPropertyName("clientTimeOffsetMs")] public long ClientTimeOffsetMs { get; init; }
    [JsonPropertyName("submarines")] public IReadOnlyList<SyncSubmarineDto> Submarines { get; init; } = Array.Empty<SyncSubmarineDto>();
}

public sealed record SyncResponseDto
{
    [JsonPropertyName("accepted")] public int Accepted { get; init; }
    [JsonPropertyName("changed")] public int Changed { get; init; }
    [JsonPropertyName("removed")] public int Removed { get; init; }
    [JsonPropertyName("deduped")] public bool Deduped { get; init; }
    // 云端已存有采集时刻更新的数据，本次上报被丢弃（同一账号在另一处登录留下的旧快照）
    [JsonPropertyName("stale")] public bool Stale { get; init; }
    [JsonPropertyName("serverTime")] public long ServerTime { get; init; }
    [JsonPropertyName("nextSyncAfter")] public long NextSyncAfter { get; init; }
}

public sealed record RegisterResponseDto
{
    [JsonPropertyName("userId")] public string UserId { get; init; } = string.Empty;
    [JsonPropertyName("token")] public string Token { get; init; } = string.Empty;
    [JsonPropertyName("tokenPrefix")] public string TokenPrefix { get; init; } = string.Empty;
    [JsonPropertyName("deviceId")] public string DeviceId { get; init; } = string.Empty;
}

/// <summary>POST /auth/device 的响应：不含 userId（沿用当前 token 对应的用户）。</summary>
public sealed record DeviceRegistrationDto
{
    [JsonPropertyName("deviceId")] public string DeviceId { get; init; } = string.Empty;
    [JsonPropertyName("token")] public string Token { get; init; } = string.Empty;
    [JsonPropertyName("tokenPrefix")] public string TokenPrefix { get; init; } = string.Empty;
    [JsonPropertyName("serverTime")] public long ServerTime { get; init; }
}

public sealed record StatusResponseDto
{
    [JsonPropertyName("userId")] public string UserId { get; init; } = string.Empty;
    [JsonPropertyName("serverTime")] public long ServerTime { get; init; }
    [JsonPropertyName("scheduler")] public SchedulerStatusDto? Scheduler { get; init; }
    [JsonPropertyName("submarines")] public SubmarineCountsDto? Submarines { get; init; }
    [JsonPropertyName("lastNotification")] public LastNotificationDto? LastNotification { get; init; }
    [JsonPropertyName("providerConfigured")] public bool ProviderConfigured { get; init; }
    [JsonPropertyName("notificationEnabled")] public bool NotificationEnabled { get; init; }
}

public sealed record LastNotificationDto
{
    [JsonPropertyName("eventType")] public string EventType { get; init; } = string.Empty;
    [JsonPropertyName("status")] public string Status { get; init; } = string.Empty;
    [JsonPropertyName("at")] public long At { get; init; }
}

public sealed record SchedulerStatusDto
{
    [JsonPropertyName("nextAlarmAt")] public long? NextAlarmAt { get; init; }
    [JsonPropertyName("pendingBatches")] public int PendingBatches { get; init; }
}

public sealed record SubmarineCountsDto
{
    [JsonPropertyName("total")] public int Total { get; init; }
    [JsonPropertyName("sailing")] public int Sailing { get; init; }
    [JsonPropertyName("returned")] public int Returned { get; init; }
    [JsonPropertyName("docked")] public int Docked { get; init; }
}

public sealed record HealthDto
{
    [JsonPropertyName("status")] public string Status { get; init; } = string.Empty;
    [JsonPropertyName("serverTime")] public long ServerTime { get; init; }
}

public sealed record DeviceDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = string.Empty;
    [JsonPropertyName("name")] public string Name { get; init; } = string.Empty;
    [JsonPropertyName("status")] public string Status { get; init; } = string.Empty;
    [JsonPropertyName("lastSeenAt")] public long? LastSeenAt { get; init; }
    [JsonPropertyName("createdAt")] public long CreatedAt { get; init; }
}

public sealed record WhoAmIDto
{
    [JsonPropertyName("userId")] public string UserId { get; init; } = string.Empty;
    [JsonPropertyName("tokenPrefix")] public string TokenPrefix { get; init; } = string.Empty;
    [JsonPropertyName("deviceId")] public string DeviceId { get; init; } = string.Empty;
    [JsonPropertyName("devices")] public IReadOnlyList<DeviceDto> Devices { get; init; } = Array.Empty<DeviceDto>();
    [JsonPropertyName("serverTime")] public long ServerTime { get; init; }
}

/// <summary>GET /settings 的响应。注意：不包含任何推送凭据明文。</summary>
public sealed record SettingsDto
{
    [JsonPropertyName("mergeWindowMinutes")] public int MergeWindowMinutes { get; init; }
    [JsonPropertyName("advanceNotificationMinutes")] public int AdvanceNotificationMinutes { get; init; }
    [JsonPropertyName("notificationEnabled")] public bool NotificationEnabled { get; init; }
    [JsonPropertyName("provider")] public string Provider { get; init; } = "none";
    [JsonPropertyName("providerServerUrl")] public string ProviderServerUrl { get; init; } = string.Empty;
    [JsonPropertyName("providerTopic")] public string ProviderTopic { get; init; } = string.Empty;
    [JsonPropertyName("providerConfigured")] public bool ProviderConfigured { get; init; }
    [JsonPropertyName("providerTokenMasked")] public string ProviderTokenMasked { get; init; } = string.Empty;
    [JsonPropertyName("notifyTitle")] public string NotifyTitle { get; init; } = string.Empty;
    [JsonPropertyName("notifyBodyTemplate")] public string NotifyBodyTemplate { get; init; } = string.Empty;
    [JsonPropertyName("notifyGroup")] public string NotifyGroup { get; init; } = string.Empty;
    [JsonPropertyName("notifySound")] public string NotifySound { get; init; } = string.Empty;
    [JsonPropertyName("notifyIcon")] public string NotifyIcon { get; init; } = string.Empty;
    [JsonPropertyName("notifyPriority")] public string NotifyPriority { get; init; } = string.Empty;
    [JsonPropertyName("timezone")] public string Timezone { get; init; } = "Asia/Shanghai";
    [JsonPropertyName("updatedAt")] public long UpdatedAt { get; init; }
}

/// <summary>PUT /settings 的增量请求体；null 字段不下发（表示不修改）。</summary>
public sealed record SettingsPatchDto
{
    [JsonPropertyName("mergeWindowMinutes")] public int? MergeWindowMinutes { get; init; }
    [JsonPropertyName("advanceNotificationMinutes")] public int? AdvanceNotificationMinutes { get; init; }
    [JsonPropertyName("notificationEnabled")] public bool? NotificationEnabled { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("providerServerUrl")] public string? ProviderServerUrl { get; init; }
    [JsonPropertyName("providerTopic")] public string? ProviderTopic { get; init; }

    /// <summary>推送凭据明文。仅在用户主动填写时下发；云端加密保存且永不回传。</summary>
    [JsonPropertyName("providerToken")] public string? ProviderToken { get; init; }

    [JsonPropertyName("notifyTitle")] public string? NotifyTitle { get; init; }
    [JsonPropertyName("notifyBodyTemplate")] public string? NotifyBodyTemplate { get; init; }
    [JsonPropertyName("notifyGroup")] public string? NotifyGroup { get; init; }
    [JsonPropertyName("notifySound")] public string? NotifySound { get; init; }
    [JsonPropertyName("notifyIcon")] public string? NotifyIcon { get; init; }
    [JsonPropertyName("notifyPriority")] public string? NotifyPriority { get; init; }
    [JsonPropertyName("timezone")] public string? Timezone { get; init; }
}

/// <summary>POST /push/test 请求体。用于在保存前验证一组凭据。</summary>
public sealed record TestPushRequestDto
{
    [JsonPropertyName("provider")] public string Provider { get; init; } = "bark";
    [JsonPropertyName("serverUrl")] public string? ServerUrl { get; init; }
    [JsonPropertyName("deviceKey")] public string? DeviceKey { get; init; }
    [JsonPropertyName("topic")] public string? Topic { get; init; }
}

public sealed record TestPushResultDto
{
    [JsonPropertyName("delivered")] public bool Delivered { get; init; }
    [JsonPropertyName("provider")] public string Provider { get; init; } = string.Empty;
    [JsonPropertyName("latencyMs")] public int LatencyMs { get; init; }
}

/// <summary>POST /push/next 的返回：立即发出的那条「下次返航」通知的描述。</summary>
public sealed record NextPushResultDto
{
    [JsonPropertyName("delivered")] public bool Delivered { get; init; }
    [JsonPropertyName("provider")] public string Provider { get; init; } = string.Empty;
    [JsonPropertyName("latencyMs")] public int LatencyMs { get; init; }
    /// <summary>advance = 即将返航提前通知；returned = 正式返航通知。</summary>
    [JsonPropertyName("kind")] public string Kind { get; init; } = string.Empty;
    [JsonPropertyName("notifyAt")] public long NotifyAt { get; init; }
    [JsonPropertyName("returnAt")] public long ReturnAt { get; init; }
    [JsonPropertyName("shipCount")] public int ShipCount { get; init; }
    [JsonPropertyName("title")] public string Title { get; init; } = string.Empty;
}

/// <summary>云端统一响应包装：{ ok, data } / { ok:false, error:{code,message} }。</summary>
public sealed record ApiEnvelope<T>
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
    [JsonPropertyName("data")] public T? Data { get; init; }
    [JsonPropertyName("error")] public ApiErrorDto? Error { get; init; }
}

public sealed record ApiErrorDto
{
    [JsonPropertyName("code")] public string Code { get; init; } = string.Empty;
    [JsonPropertyName("message")] public string Message { get; init; } = string.Empty;
}
