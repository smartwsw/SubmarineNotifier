using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Logging;
using SubmarineReturnNotifier.Core.Storage;

namespace SubmarineReturnNotifier.Tests;

/// <summary>内存缓存：不触碰磁盘，便于确定性地测试上传流程。</summary>
internal sealed class InMemoryCache : ICacheStore
{
    public CacheDocument Document { get; } = new();
    public object SyncRoot { get; } = new();
    public string FilePath => "(memory)";
    public int SaveCount { get; private set; }

    public void Save() => SaveCount++;

    public void AddError(string message)
    {
        lock (SyncRoot) Document.Errors.Insert(0, new ErrorLogEntry { At = DateTimeOffset.UnixEpoch, Message = message });
    }

    public void Seed(CacheDocument document)
    {
        lock (SyncRoot)
        {
            Document.ApiBaseUrl = document.ApiBaseUrl;
            Document.UserId = document.UserId;
            Document.DeviceId = document.DeviceId;
            Document.TokenPrefix = document.TokenPrefix;
            Document.Pending = document.Pending;
            Document.LastScan = document.LastScan;
        }
    }
}

/// <summary>脚本化的云端：按队列返回响应，并记录收到的请求。</summary>
internal sealed class FakeCloudApi : ICloudApi
{
    private readonly Queue<CloudResponse<SyncResponseDto>> _responses = new();

    public FakeCloudApi(string baseUrl = "https://worker.test", string token = "srk_test_token")
    {
        BaseUrl = baseUrl;
        Token = token;
    }

    public string BaseUrl { get; }
    public string Token { get; }
    public List<SyncRequestDto> Requests { get; } = new();
    public bool ThrowOnSync { get; set; }
    public Exception? ThrowException { get; set; }

    public FakeCloudApi Respond(CloudResponse<SyncResponseDto> response)
    {
        _responses.Enqueue(response);
        return this;
    }

    public FakeCloudApi RespondOk(int accepted = 1, int changed = 1, bool deduped = false, bool stale = false)
        => Respond(CloudResponse<SyncResponseDto>.Ok(new SyncResponseDto
        {
            Accepted = accepted,
            Changed = changed,
            Removed = 0,
            Deduped = deduped,
            Stale = stale,
            ServerTime = TestData.T0,
            NextSyncAfter = TestData.T0 + 60,
        }));

    public Task<CloudResponse<SyncResponseDto>> SyncAsync(SyncRequestDto payload, CancellationToken cancellationToken)
    {
        Requests.Add(payload);
        if (ThrowException is not null) throw ThrowException;
        if (_responses.Count == 0)
            return Task.FromResult(CloudResponse<SyncResponseDto>.Fail("NO_SCRIPT", "no scripted response"));
        return Task.FromResult(_responses.Dequeue());
    }
}

internal sealed class RecordingLog : ILogSink
{
    public List<string> Messages { get; } = new();

    public void Info(string message) => Messages.Add("INFO " + message);
    public void Warn(string message) => Messages.Add("WARN " + message);
    public void Error(string message) => Messages.Add("ERROR " + message);
    public void Debug(string message) => Messages.Add("DEBUG " + message);
}
