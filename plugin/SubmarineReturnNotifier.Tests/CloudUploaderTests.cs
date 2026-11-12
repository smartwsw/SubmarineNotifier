using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Storage;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>
/// 上传流程：失败重试、去重、认证失败、缓存恢复（对应 TODO §11 的上传相关条目）。
/// </summary>
public class CloudUploaderTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch.AddSeconds(TestData.T0);

    private sealed class Harness
    {
        public required InMemoryCache Cache { get; init; }
        public required FakeCloudApi Api { get; init; }
        public required CloudUploader Uploader { get; init; }
        public required RecordingLog Log { get; init; }
    }

    private static Harness Create()
    {
        var cache = new InMemoryCache();
        var api = new FakeCloudApi();
        var log = new RecordingLog();
        var uploader = new CloudUploader(api, cache, log, () => Now, randomSeed: 1);
        return new Harness { Cache = cache, Api = api, Uploader = uploader, Log = log };
    }

    private static void SeedScan(CloudUploader uploader, string characterId = TestData.CharacterId, long returnAt = TestData.T0 + 3600)
    {
        var scan = TestData.Scan(characterId, TestData.T0, true, TestData.Sub(0, returnAt: returnAt));
        var hash = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(scan, TestData.T0));
        uploader.RecordScan(scan, hash);
    }

    [Fact]
    public async Task Not_configured_without_base_url()
    {
        var cache = new InMemoryCache();
        var uploader = new CloudUploader(new FakeCloudApi(baseUrl: "", token: "t"), cache, new RecordingLog(), () => Now);

        var result = await uploader.TryUploadAsync(force: true, CancellationToken.None);

        Assert.Equal(UploadOutcome.NotConfigured, result.Outcome);
    }

    [Fact]
    public async Task Not_configured_without_token()
    {
        var cache = new InMemoryCache();
        var uploader = new CloudUploader(new FakeCloudApi(baseUrl: "https://x.test", token: ""), cache, new RecordingLog(), () => Now);

        var result = await uploader.TryUploadAsync(force: true, CancellationToken.None);

        Assert.Equal(UploadOutcome.NotConfigured, result.Outcome);
    }

    [Fact]
    public async Task No_pending_data_means_no_upload()
    {
        var h = Create();
        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.NoChanges, result.Outcome);
        Assert.Empty(h.Api.Requests);
    }

    [Fact]
    public async Task Success_upload_sends_payload_and_records_hash()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk(accepted: 1);

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Success, result.Outcome);
        Assert.Single(h.Api.Requests);
        Assert.Equal(TestData.CharacterId, h.Api.Requests[0].CharacterId);
        Assert.NotNull(h.Cache.Document.Pending!.LastPayloadHash);
        Assert.Equal(Now, h.Cache.Document.Pending.LastSuccessAt);
    }

    [Fact]
    public async Task Identical_content_is_not_uploaded_twice()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk();
        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        // 重新扫描同样的内容（采集时间变了，但返航时间没变）
        SeedScan(h.Uploader);
        var second = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Single(h.Api.Requests);
        Assert.Equal(UploadOutcome.NoChanges, second.Outcome);
    }

    [Fact]
    public void RecordScan_reports_change_only_when_return_time_changes()
    {
        var h = Create();
        var first = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0));
        var same = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true, TestData.Sub(0));
        var moved = TestData.Scan(TestData.CharacterId, TestData.T0 + 120, true, TestData.Sub(0, returnAt: TestData.T0 + 9000));

        Assert.True(h.Uploader.RecordScan(first, Hash(first, TestData.T0)));
        Assert.False(h.Uploader.RecordScan(same, Hash(same, TestData.T0 + 60)));
        Assert.True(h.Uploader.RecordScan(moved, Hash(moved, TestData.T0 + 120)));
    }

    private static string Hash(ScanResult scan, long nowUnix)
        => Hashing.HashSyncRequest(SyncPayloadBuilder.Build(scan, nowUnix));

    [Fact]
    public void Workshop_not_loaded_does_not_produce_pending_upload()
    {
        var h = Create();

        var changed = h.Uploader.RecordScan(TestData.Scan(TestData.CharacterId, TestData.T0, workshopLoaded: false), null);

        Assert.False(changed);
        Assert.Null(h.Cache.Document.Pending);
    }

    [Fact]
    public async Task Server_error_schedules_backoff_and_retains_data()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.Respond(CloudResponse<SyncResponseDto>.Fail("INTERNAL", "boom", 500));

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Failed, result.Outcome);
        Assert.Equal(1, h.Uploader.PendingAttempts);
        Assert.NotNull(h.Uploader.NextAttemptAt);
        Assert.NotNull(h.Cache.Document.Pending);
        Assert.True(h.Cache.Document.Pending!.HasPending);
    }

    [Fact]
    public async Task Backoff_window_prevents_immediate_retry()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.Respond(CloudResponse<SyncResponseDto>.Fail("INTERNAL", "boom", 500));
        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        h.Api.RespondOk();
        var second = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Backoff, second.Outcome);
        Assert.Single(h.Api.Requests);
    }

    [Fact]
    public async Task Retry_succeeds_after_backoff_expires()
    {
        var cache = new InMemoryCache();
        var api = new FakeCloudApi();
        var log = new RecordingLog();
        var now = Now;
        var uploader = new CloudUploader(api, cache, log, () => now, randomSeed: 1);

        SeedScan(uploader);
        api.Respond(CloudResponse<SyncResponseDto>.Fail("INTERNAL", "boom", 503));
        await uploader.TryUploadAsync(force: false, CancellationToken.None);

        now = Now.AddMinutes(15);
        api.RespondOk(accepted: 1);
        var retry = await uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Success, retry.Outcome);
        Assert.Equal(0, uploader.PendingAttempts);
        Assert.Null(uploader.LastError);
        Assert.Equal(2, api.Requests.Count);
    }

    [Fact]
    public async Task Unauthorized_is_not_retried()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.Respond(CloudResponse<SyncResponseDto>.Fail("UNAUTHORIZED", "bad token", 401));

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Failed, result.Outcome);
        Assert.Equal(401, result.StatusCode);
        Assert.Null(h.Uploader.NextAttemptAt);
        Assert.Contains("认证失败", h.Uploader.LastError);
    }

    [Fact]
    public async Task Validation_error_stops_automatic_retry()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.Respond(CloudResponse<SyncResponseDto>.Fail("VALIDATION_ERROR", "bad slot", 400));

        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(RetryPolicy.MaxAttemptsBeforeBackingOff, h.Uploader.PendingAttempts);
        Assert.Null(h.Uploader.NextAttemptAt);
    }

    [Fact]
    public async Task Rate_limit_is_retryable()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.Respond(CloudResponse<SyncResponseDto>.Fail("RATE_LIMITED", "slow down", 429));

        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(1, h.Uploader.PendingAttempts);
        Assert.NotNull(h.Uploader.NextAttemptAt);
    }

    [Fact]
    public async Task Deduplicated_response_is_reported_as_deduped()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk(accepted: 0, changed: 0, deduped: true);

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Deduped, result.Outcome);
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task Force_upload_ignores_unchanged_hash()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk();
        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        h.Api.RespondOk(accepted: 1);
        var forced = await h.Uploader.TryUploadAsync(force: true, CancellationToken.None);

        Assert.Equal(UploadOutcome.Success, forced.Outcome);
        Assert.Equal(2, h.Api.Requests.Count);
    }

    [Fact]
    public async Task Network_exception_is_swallowed_and_scheduled_for_retry()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.ThrowException = new HttpRequestException("connection reset");

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Failed, result.Outcome);
        Assert.Contains(h.Log.Messages, m => m.StartsWith("ERROR", StringComparison.Ordinal));
        Assert.NotNull(h.Cache.Document.Pending);
    }

    [Fact]
    public async Task Pending_payload_is_sent_after_reload_from_disk()
    {
        // 模拟"游戏重启后恢复上传"：待上传数据只来自磁盘缓存
        var cache = new InMemoryCache();
        var scan = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0));
        cache.Seed(new CacheDocument
        {
            ApiBaseUrl = "https://worker.test",
            Pending = PendingUpload.FromScan(scan),
        });

        var api = new FakeCloudApi();
        api.RespondOk(accepted: 1);
        var uploader = new CloudUploader(api, cache, new RecordingLog(), () => Now, randomSeed: 1);

        var result = await uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Success, result.Outcome);
        Assert.Single(api.Requests);
    }

    [Fact]
    public async Task Stale_response_marks_content_uploaded_and_is_not_retried()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk(accepted: 0, changed: 0, stale: true);

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal(UploadOutcome.Stale, result.Outcome);
        Assert.True(result.IsSuccess);
        // 记录哈希后不会每分钟重发同一份旧数据
        Assert.NotNull(h.Cache.Document.Pending!.LastPayloadHash);
        Assert.Equal(0, h.Uploader.PendingAttempts);

        var second = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);
        Assert.Equal(UploadOutcome.NoChanges, second.Outcome);
        Assert.Single(h.Api.Requests);
    }

    [Fact]
    public async Task Stale_response_message_is_surfaced_to_the_user()
    {
        var h = Create();
        SeedScan(h.Uploader);
        h.Api.RespondOk(accepted: 0, changed: 0, stale: true);

        var result = await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Contains("云端已有更新的数据", result.Message);
        Assert.Contains("云端已有更新的采集结果", h.Cache.Document.Pending!.LastError);
    }

    [Fact]
    public void Workshop_not_loaded_keeps_previous_cache_instead_of_clearing_it()
    {
        var h = Create();
        SeedScan(h.Uploader);
        var cached = h.Cache.Document.LastScan!;
        Assert.Single(cached.Submarines);

        // 设备 B 登录但没打开工坊：读到"数据不可用"，不是"没有潜水艇"
        var empty = TestData.Scan(collectedAt: TestData.T0 + 600, workshopLoaded: false);
        var hash = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(empty, TestData.T0 + 600));
        var changed = h.Uploader.RecordScan(empty, hash);

        Assert.False(changed);
        Assert.Single(h.Cache.Document.LastScan!.Submarines);
        Assert.Equal(cached.CollectedAt, h.Cache.Document.LastScan!.CollectedAt);
        // 也不产生新的待上传数据（不会把空列表推给云端把记录删掉）
        Assert.Equal(TestData.T0, h.Cache.Document.Pending!.CollectedAt);
    }

    [Fact]
    public void Workshop_not_loaded_on_first_scan_still_produces_nothing_to_upload()
    {
        var h = Create();
        var empty = TestData.Scan(workshopLoaded: false);
        var hash = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(empty, TestData.T0));

        Assert.False(h.Uploader.RecordScan(empty, hash));
        Assert.Null(h.Cache.Document.Pending);
    }

    [Fact]
    public void Server_time_calibration_persists_clock_offset()
    {
        var h = Create();
        // 本机时钟比服务器慢 90 秒
        h.Uploader.NoteServerTime(TestData.T0 + 90);

        Assert.Equal(90_000, h.Uploader.CurrentClockOffsetMs());
    }

    [Fact]
    public async Task Clock_offset_is_sent_in_sync_payload()
    {
        var h = Create();
        h.Uploader.NoteServerTime(TestData.T0 + 90);
        SeedScan(h.Uploader);
        h.Api.RespondOk();

        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Single(h.Api.Requests);
        Assert.Equal(90_000, h.Api.Requests[0].ClientTimeOffsetMs);
    }

    [Fact]
    public void Absurdly_large_server_time_skew_is_ignored()
    {
        var h = Create();
        h.Uploader.NoteServerTime(TestData.T0 + 10 * 86400);

        Assert.Equal(0, h.Uploader.CurrentClockOffsetMs());
    }

    [Fact]
    public async Task Character_switch_replaces_pending_payload()
    {
        var h = Create();
        SeedScan(h.Uploader, "character-a");
        SeedScan(h.Uploader, "character-b");

        Assert.Equal("character-b", h.Cache.Document.Pending!.CharacterId);
        h.Api.RespondOk();
        await h.Uploader.TryUploadAsync(force: false, CancellationToken.None);

        Assert.Equal("character-b", h.Api.Requests[0].CharacterId);
    }
}
