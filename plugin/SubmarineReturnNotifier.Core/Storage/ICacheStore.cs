namespace SubmarineReturnNotifier.Core.Storage;

/// <summary>
/// 上传链路依赖的最小缓存接口。把"读/写/加锁"抽象出来后，
/// <see cref="Cloud.CloudUploader"/> 可以在没有真实文件系统的情况下测试。
/// </summary>
public interface ICacheStore
{
    CacheDocument Document { get; }

    /// <summary>保护 <see cref="Document"/> 的互斥体（主线程与线程池都会访问）。</summary>
    object SyncRoot { get; }

    string FilePath { get; }

    void Save();

    /// <summary>追加一条人类可读的错误记录（实现方负责上限截断）。</summary>
    void AddError(string message);
}
