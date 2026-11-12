using Dalamud.Configuration;
using Dalamud.Plugin;

namespace SubmarineReturnNotifier;

[Serializable]
public sealed class Configuration : IPluginConfiguration
{
    public int Version { get; set; } = 1;

    /// <summary>Cloudflare Worker 地址，例如 https://submarine-notifier.example.workers.dev</summary>
    public string ApiBaseUrl { get; set; } = string.Empty;

    /// <summary>API Token（srk_...）。仅保存在本机插件配置中，不写日志。</summary>
    public string ApiToken { get; set; } = string.Empty;

    public string UserId { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string TokenPrefix { get; set; } = string.Empty;

    public string DeviceName { get; set; } = "FF14 客户端";

    /// <summary>自动扫描并上传的间隔（秒）。0 表示只响应事件，不定时扫描。</summary>
    public int AutoScanIntervalSeconds { get; set; } = 60;

    /// <summary>是否在登录后自动上传首次扫描结果。</summary>
    public bool UploadOnLogin { get; set; } = true;

    public bool ShowDebugLog { get; set; }

    /// <summary>缓存的绝对返航时间与待上传数据（由 LocalCacheStore 持久化到独立文件）。</summary>
    public string CacheDirectory { get; set; } = string.Empty;

    public void Save()
    {
        Plugin.PluginInterface.SavePluginConfig(this);
    }
}
