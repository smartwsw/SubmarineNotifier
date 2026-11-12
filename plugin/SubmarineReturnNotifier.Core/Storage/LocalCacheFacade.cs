namespace SubmarineReturnNotifier.Core.Storage;

/// <summary>
/// 基于 <see cref="LocalCacheStore"/> 的缓存实现：从插件配置目录加载，保存时写回磁盘。
/// 只保存非敏感状态；API token 由插件配置保存。
/// </summary>
public sealed class LocalCacheFacade : ICacheStore
{
    private readonly LocalCacheStore _store;

    public LocalCacheFacade(string pluginConfigDirectory)
    {
        _store = new LocalCacheStore(pluginConfigDirectory);
        Document = _store.Load();
    }

    public object SyncRoot { get; } = new();
    public string FilePath => _store.FilePath;
    public CacheDocument Document { get; }

    public void Save()
    {
        lock (SyncRoot) _store.Save(Document);
    }

    public void Reload()
    {
        lock (SyncRoot)
        {
            var loaded = _store.Load();
            Document.Version = loaded.Version;
            Document.ApiBaseUrl = loaded.ApiBaseUrl;
            Document.UserId = loaded.UserId;
            Document.DeviceId = loaded.DeviceId;
            Document.TokenPrefix = loaded.TokenPrefix;
            Document.Pending = loaded.Pending;
            Document.LastScan = loaded.LastScan;
            Document.Errors = loaded.Errors;
            Document.ClockOffsetMs = loaded.ClockOffsetMs;
        }
    }

    public void AddError(string message)
    {
        lock (SyncRoot)
        {
            Document.Errors.Insert(0, new ErrorLogEntry { At = DateTimeOffset.UtcNow, Message = message });
            if (Document.Errors.Count > 20) Document.Errors.RemoveRange(20, Document.Errors.Count - 20);
        }
    }
}
