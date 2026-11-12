using System.Text.Json;
using System.Text.Json.Serialization;

namespace SubmarineReturnNotifier.Core.Storage;

/// <summary>需要持久化到磁盘的本地状态（不含明文推送密钥）。</summary>
public sealed class CacheDocument
{
    [JsonPropertyName("version")] public int Version { get; set; } = 1;
    [JsonPropertyName("apiBaseUrl")] public string ApiBaseUrl { get; set; } = string.Empty;
    [JsonPropertyName("userId")] public string UserId { get; set; } = string.Empty;
    [JsonPropertyName("deviceId")] public string DeviceId { get; set; } = string.Empty;
    [JsonPropertyName("tokenPrefix")] public string TokenPrefix { get; set; } = string.Empty;
    [JsonPropertyName("pending")] public PendingUpload? Pending { get; set; }
    [JsonPropertyName("lastScan")] public PendingUpload? LastScan { get; set; }
    [JsonPropertyName("lastErrorLog")] public List<ErrorLogEntry> Errors { get; set; } = new();

    /// <summary>
    /// 本机时钟与云端的偏差（毫秒，= 云端时间 − 本机时间）。
    /// 为 null 表示从未校准过，此时上报的 collectedAt 不带校正。
    /// </summary>
    [JsonPropertyName("clockOffsetMs")] public long? ClockOffsetMs { get; set; }
}

public sealed class ErrorLogEntry
{
    [JsonPropertyName("at")] public DateTimeOffset At { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; } = string.Empty;
}

/// <summary>
/// 基于文件的缓存实现。写入使用"临时文件 + 原子替换"，避免游戏/插件崩溃时留下半截 JSON。
/// 只负责读写，不含业务判断，便于单元测试。
/// </summary>
public sealed class LocalCacheStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _path;

    public LocalCacheStore(string directory, string fileName = "submarine-notifier.cache.json")
    {
        DirectoryPath = directory;
        _path = Path.Combine(directory, fileName);
    }

    public string DirectoryPath { get; }
    public string FilePath => _path;

    /// <summary>读取缓存；文件不存在、损坏或版本不兼容时返回全新文档而不是抛异常。</summary>
    public CacheDocument Load()
    {
        try
        {
            if (!File.Exists(_path)) return new CacheDocument();
            var json = File.ReadAllText(_path);
            if (string.IsNullOrWhiteSpace(json)) return new CacheDocument();
            var doc = JsonSerializer.Deserialize<CacheDocument>(json, Options);
            if (doc is null || doc.Version != 1) return new CacheDocument();
            return doc;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new CacheDocument();
        }
    }

    public void Save(CacheDocument document)
    {
        Directory.CreateDirectory(DirectoryPath);
        var temp = _path + ".tmp";
        var json = JsonSerializer.Serialize(document, Options);
        File.WriteAllText(temp, json);

        if (File.Exists(_path))
        {
            // File.Replace 在同一卷上原子替换；失败时回退到覆盖写
            try
            {
                File.Replace(temp, _path, null);
                return;
            }
            catch (Exception ex) when (ex is IOException or PlatformNotSupportedException or UnauthorizedAccessException)
            {
                File.Copy(temp, _path, overwrite: true);
                TryDelete(temp);
                return;
            }
        }

        File.Move(temp, _path);
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
            // 忽略清理失败
        }
    }
}
