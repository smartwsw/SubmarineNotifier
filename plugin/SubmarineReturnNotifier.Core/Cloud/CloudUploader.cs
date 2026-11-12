using SubmarineReturnNotifier.Core.Logging;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Storage;
using SubmarineReturnNotifier.Core.Submarine;

namespace SubmarineReturnNotifier.Core.Cloud;

public enum UploadOutcome
{
    NotConfigured,
    NoChanges,
    Success,
    Deduped,
    Failed,
    Backoff,
    /// <summary>云端已存有采集时刻更新的数据，本次上报被丢弃（旧快照保护）。</summary>
    Stale,
}

public sealed record UploadResult
{
    public required UploadOutcome Outcome { get; init; }
    public string? Message { get; init; }
    public int? StatusCode { get; init; }

    public bool IsSuccess => Outcome is UploadOutcome.Success or UploadOutcome.Deduped or UploadOutcome.Stale;
}

/// <summary>
/// 负责"何时上传"与"失败后如何重试"。
///
/// 设计要点：
///  - 所有网络请求在线程池上执行，绝不在游戏主线程同步等待；
///  - 上传失败只记录到本地缓存，不影响游戏；
///  - 同一时刻只允许一个上传在途（防止重复上传）；
///  - 重试用指数退避，且可在游戏重启后从本地缓存恢复。
/// </summary>
public sealed class CloudUploader
{
    private readonly ICloudApi _client;
    private readonly ICacheStore _cache;
    private readonly ILogSink _log;
    private readonly Func<DateTimeOffset> _now;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Random _random;

    public CloudUploader(
        ICloudApi client,
        ICacheStore cache,
        ILogSink? log = null,
        Func<DateTimeOffset>? now = null,
        int randomSeed = 0)
    {
        _client = client;
        _cache = cache;
        _log = log ?? NullLogSink.Instance;
        _now = now ?? (() => DateTimeOffset.UtcNow);
        _random = randomSeed == 0 ? new Random() : new Random(randomSeed);
    }

    public DateTimeOffset? LastSuccessAt
    {
        get { lock (_cache.SyncRoot) return _cache.Document.Pending?.LastSuccessAt; }
    }

    public string? LastError
    {
        get { lock (_cache.SyncRoot) return _cache.Document.Pending?.LastError; }
    }

    public int PendingAttempts
    {
        get { lock (_cache.SyncRoot) return _cache.Document.Pending?.Attempts ?? 0; }
    }

    /// <summary>
    /// 用云端返回的服务器时间校准本机时钟偏差，供后续 sync 的 <c>clientTimeOffsetMs</c> 使用。
    ///
    /// 云端用 <c>采集时刻 + 偏差</c> 判断新旧快照；不校准的话，本机时钟慢的设备
    /// 会被自认为"旧数据"而导致真实的新数据传不上去。
    /// </summary>
    public void NoteServerTime(long serverTimeUnix)
    {
        if (serverTimeUnix <= 0) return;
        var serverMs = serverTimeUnix * 1000L;
        var localMs = _now().ToUnixTimeMilliseconds();
        var offset = serverMs - localMs;
        // 超过 1 天说明要么本机时钟严重错乱，要么服务器时间异常；宁可不校正
        if (Math.Abs(offset) > 86_400_000L) return;

        lock (_cache.SyncRoot)
        {
            _cache.Document.ClockOffsetMs = offset;
            _cache.Save();
        }
    }

    /// <summary>当前已知的时钟偏差（毫秒）；未校准过返回 0。</summary>
    public int CurrentClockOffsetMs()
    {
        lock (_cache.SyncRoot)
        {
            var offset = _cache.Document.ClockOffsetMs ?? 0;
            return (int)Math.Clamp(offset, -86_400_000L, 86_400_000L);
        }
    }

    public DateTimeOffset? NextAttemptAt
    {
        get { lock (_cache.SyncRoot) return _cache.Document.Pending?.NextAttemptAt; }
    }

    /// <summary>记录最新扫描结果，供后续上传使用。返回是否产生了需要上传的变化。</summary>
    public bool RecordScan(ScanResult scan, string? payloadHash)
    {
        lock (_cache.SyncRoot)
        {
            var doc = _cache.Document;

            // 工坊未加载：本机读不到数据，这既不是"潜水艇都没了"，也不该覆盖已有缓存。
            // 必须在写 LastScan 之前返回，否则缓存会被替换成空列表。
            if (!scan.WorkshopLoaded)
            {
                _cache.Save();
                return false;
            }

            var changed = ChangeDetector.Compare(doc.LastScan?.ToScanResult(), scan).HasChanges;
            doc.LastScan = PendingUpload.FromScan(scan);

            // 内容与"待上传内容"或"上次成功上传内容"一致 → 不产生新的待上传数据
            if (!changed && payloadHash is not null && doc.Pending is not null)
            {
                var pendingHash = Hashing.HashSyncRequest(doc.Pending.ToRequest(doc.Pending.CollectedAt));
                if (string.Equals(pendingHash, payloadHash, StringComparison.Ordinal) ||
                    string.Equals(doc.Pending.LastPayloadHash, payloadHash, StringComparison.Ordinal))
                {
                    return false;
                }
            }

            var previous = doc.Pending ?? new PendingUpload();
            var next = PendingUpload.FromScan(scan);
            next.LastSuccessAt = previous.LastSuccessAt;
            next.LastPayloadHash = previous.LastPayloadHash;
            next.LastError = previous.LastError;
            next.Attempts = previous.Attempts;
            next.NextAttemptAt = previous.NextAttemptAt;
            doc.Pending = next;

            _cache.Save();
            return true;
        }
    }

    /// <summary>目前是否可以立即上传（用于界面展示）。</summary>
    public bool CanUploadNow(bool force)
    {
        lock (_cache.SyncRoot)
        {
            return UploadScheduler
                .Evaluate(_cache.Document.Pending, _client.Token.Length > 0, force, _now())
                .Decision == UploadDecision.Upload;
        }
    }

    /// <summary>执行一次上传尝试；不会抛异常。</summary>
    public async Task<UploadResult> TryUploadAsync(bool force, CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            return new UploadResult { Outcome = UploadOutcome.Backoff, Message = "已有上传正在进行" };
        }

        try
        {
            SyncRequestDto request;
            string hash;

            // 在锁内取出快照；网络请求期间不持锁，避免阻塞扫描线程
            lock (_cache.SyncRoot)
            {
                if (_client.BaseUrl.Length == 0)
                    return new UploadResult { Outcome = UploadOutcome.NotConfigured, Message = "未设置 API 地址" };

                if (_client.Token.Length == 0)
                    return new UploadResult { Outcome = UploadOutcome.NotConfigured, Message = "尚未绑定设备" };

                var pending = _cache.Document.Pending;
                var plan = UploadScheduler.Evaluate(pending, hasToken: true, force, _now());

                if (plan.Decision == UploadDecision.Skip && plan.Delay is null)
                    return new UploadResult { Outcome = UploadOutcome.NoChanges, Message = plan.Reason };

                if (plan.Decision == UploadDecision.Skip && plan.Delay is not null)
                    return new UploadResult { Outcome = UploadOutcome.Backoff, Message = plan.Reason };

                if (pending is null || !pending.HasPending)
                    return new UploadResult { Outcome = UploadOutcome.NoChanges, Message = "无待上传数据" };

                request = pending.ToRequest(_now().ToUnixTimeSeconds(), CurrentClockOffsetMs());
                hash = Hashing.HashSyncRequest(request);

                if (!force && !UploadScheduler.HasNewContent(pending, hash))
                    return new UploadResult { Outcome = UploadOutcome.NoChanges, Message = "内容未变化" };
            }

            var response = await _client.SyncAsync(request, cancellationToken).ConfigureAwait(false);

            if (response.Success && response.Data is { } data)
            {
                // 响应回来时 Pending 可能已被新的扫描替换，因此重新取当前对象
                lock (_cache.SyncRoot)
                {
                    if (_cache.Document.Pending is { } current)
                    {
                        UploadScheduler.RecordSuccess(current, hash, _now());
                        if (data.Stale)
                        {
                            // 这份内容云端已经有了更新的版本，标记为已上传，
                            // 避免每分钟把同一份旧数据重发一次；下次扫描产生新内容时才会再传。
                            current.LastError = "云端已有更新的采集结果，本次未覆盖（可能是另一台设备先上传）";
                        }
                    }
                    _cache.Save();
                }

                NoteServerTime(data.ServerTime);

                if (data.Stale)
                {
                    _log.Warn("[SubmarineReturnNotifier] 上传被云端判定为旧快照，已跳过覆盖");
                    return new UploadResult
                    {
                        Outcome = UploadOutcome.Stale,
                        Message = "云端已有更新的数据，本次上报未覆盖",
                        StatusCode = response.StatusCode,
                    };
                }

                _log.Info($"上传成功 accepted={data.Accepted} changed={data.Changed} removed={data.Removed} deduped={data.Deduped}");
                return new UploadResult
                {
                    Outcome = data.Deduped ? UploadOutcome.Deduped : UploadOutcome.Success,
                    Message = $"已同步 {data.Accepted} 艘" + (data.Removed > 0 ? $"，移除 {data.Removed}" : string.Empty),
                };
            }

            if (response.Unauthorized)
            {
                // token 失效是"需要用户处理"的错误，不做退避重试
                lock (_cache.SyncRoot)
                {
                    if (_cache.Document.Pending is { } current)
                    {
                        current.LastError = "认证失败，请重新绑定设备";
                        current.NextAttemptAt = null;
                    }
                    _cache.Save();
                }
                return new UploadResult
                {
                    Outcome = UploadOutcome.Failed,
                    Message = "认证失败，请重新绑定设备",
                    StatusCode = response.StatusCode,
                };
            }

            var message = response.ErrorMessage ?? response.ErrorCode ?? "上传失败";

            if (!RetryPolicy.IsRetryable(response.StatusCode))
            {
                // 数据校验类错误：保留数据但停止自动重试，等待用户手动刷新
                lock (_cache.SyncRoot)
                {
                    if (_cache.Document.Pending is { } current)
                    {
                        current.Attempts = RetryPolicy.MaxAttemptsBeforeBackingOff;
                        current.LastError = message;
                        current.NextAttemptAt = null;
                    }
                    _cache.Save();
                }
                return new UploadResult
                {
                    Outcome = UploadOutcome.Failed,
                    Message = message,
                    StatusCode = response.StatusCode,
                };
            }

            var jitter = _random.Next(-20, 21);
            DateTimeOffset next;
            int attempts;
            lock (_cache.SyncRoot)
            {
                var current = _cache.Document.Pending;
                if (current is null)
                    return new UploadResult { Outcome = UploadOutcome.Failed, Message = message, StatusCode = response.StatusCode };

                next = UploadScheduler.RecordFailure(current, message, _now(), jitter);
                attempts = current.Attempts;
                _cache.Save();
            }

            _log.Warn($"上传失败（第 {attempts} 次），下次尝试 {next:HH:mm:ss}：{message}");
            return new UploadResult
            {
                Outcome = UploadOutcome.Failed,
                Message = message,
                StatusCode = response.StatusCode,
            };
        }
        catch (OperationCanceledException)
        {
            return new UploadResult { Outcome = UploadOutcome.Failed, Message = "已取消" };
        }
        catch (Exception ex)
        {
            // 上传链路的任何意外都不能冒泡到游戏
            _log.Error($"上传异常: {ex.Message}");
            return new UploadResult { Outcome = UploadOutcome.Failed, Message = "内部错误" };
        }
        finally
        {
            _gate.Release();
        }
    }
}
