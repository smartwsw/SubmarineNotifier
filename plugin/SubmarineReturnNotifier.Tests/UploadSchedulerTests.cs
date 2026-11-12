using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Storage;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>上传时机与失败重试（对应 TODO §11 "上传失败重试"）。</summary>
public class UploadSchedulerTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch.AddSeconds(TestData.T0);

    private static PendingUpload Pending()
        => PendingUpload.FromScan(TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0)));

    [Fact]
    public void No_token_means_skip()
    {
        var plan = UploadScheduler.Evaluate(Pending(), hasToken: false, force: false, Now);
        Assert.Equal(UploadDecision.Skip, plan.Decision);
    }

    [Fact]
    public void Force_uploads_even_without_pending_data()
    {
        var plan = UploadScheduler.Evaluate(null, hasToken: true, force: true, Now);
        Assert.Equal(UploadDecision.Upload, plan.Decision);
    }

    [Fact]
    public void Without_pending_data_skip()
    {
        var plan = UploadScheduler.Evaluate(null, hasToken: true, force: false, Now);
        Assert.Equal(UploadDecision.Skip, plan.Decision);
        Assert.Null(plan.Delay);
    }

    [Fact]
    public void Pending_data_uploads_immediately()
    {
        var plan = UploadScheduler.Evaluate(Pending(), hasToken: true, force: false, Now);
        Assert.Equal(UploadDecision.Upload, plan.Decision);
    }

    [Fact]
    public void Backoff_window_blocks_upload()
    {
        var pending = Pending();
        UploadScheduler.RecordFailure(pending, "boom", Now, jitterPercent: 0);

        var plan = UploadScheduler.Evaluate(pending, hasToken: true, force: false, Now + TimeSpan.FromSeconds(1));

        Assert.Equal(UploadDecision.Skip, plan.Decision);
        Assert.NotNull(plan.Delay);
        Assert.True(plan.Delay > TimeSpan.Zero);
    }

    [Fact]
    public void After_backoff_window_upload_is_retried()
    {
        var pending = Pending();
        var next = UploadScheduler.RecordFailure(pending, "boom", Now, jitterPercent: 0);

        var plan = UploadScheduler.Evaluate(pending, hasToken: true, force: false, next + TimeSpan.FromSeconds(1));

        Assert.Equal(UploadDecision.Upload, plan.Decision);
    }

    [Fact]
    public void Force_bypasses_backoff()
    {
        var pending = Pending();
        UploadScheduler.RecordFailure(pending, "boom", Now);

        var plan = UploadScheduler.Evaluate(pending, hasToken: true, force: true, Now);

        Assert.Equal(UploadDecision.Upload, plan.Decision);
    }

    [Fact]
    public void Failure_increments_attempts_and_records_error()
    {
        var pending = Pending();
        var next = UploadScheduler.RecordFailure(pending, "网络错误", Now);

        Assert.Equal(1, pending.Attempts);
        Assert.Equal("网络错误", pending.LastError);
        Assert.Equal(next, pending.NextAttemptAt);
    }

    [Fact]
    public void Success_clears_retry_state()
    {
        var pending = Pending();
        UploadScheduler.RecordFailure(pending, "boom", Now);
        UploadScheduler.RecordSuccess(pending, "hash-1", Now);

        Assert.Equal(0, pending.Attempts);
        Assert.Null(pending.LastError);
        Assert.Null(pending.NextAttemptAt);
        Assert.Equal("hash-1", pending.LastPayloadHash);
        Assert.Equal(Now, pending.LastSuccessAt);
    }

    [Fact]
    public void Long_errors_are_truncated()
    {
        var pending = Pending();
        UploadScheduler.RecordFailure(pending, new string('x', 1000), Now);

        Assert.NotNull(pending.LastError);
        Assert.True(pending.LastError!.Length <= 500);
    }

    [Fact]
    public void HasNewContent_detects_first_and_changed_payloads()
    {
        var pending = Pending();

        Assert.True(UploadScheduler.HasNewContent(pending, "hash-1"));
        pending.LastPayloadHash = "hash-1";
        Assert.False(UploadScheduler.HasNewContent(pending, "hash-1"));
        Assert.True(UploadScheduler.HasNewContent(pending, "hash-2"));
    }

    [Fact]
    public void Backoff_grows_and_is_capped()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), RetryPolicy.DelayForAttempt(1));
        Assert.Equal(TimeSpan.FromSeconds(10), RetryPolicy.DelayForAttempt(2));
        Assert.Equal(TimeSpan.FromSeconds(20), RetryPolicy.DelayForAttempt(3));
        Assert.Equal(TimeSpan.FromMinutes(10), RetryPolicy.DelayForAttempt(20));
    }

    [Fact]
    public void Jitter_stays_within_twenty_percent()
    {
        var low = RetryPolicy.DelayForAttempt(4, -20);
        var normal = RetryPolicy.DelayForAttempt(4, 0);
        var high = RetryPolicy.DelayForAttempt(4, 20);

        Assert.True(low < normal && normal < high);
        Assert.Equal(normal.TotalSeconds * 0.8, low.TotalSeconds, 3);
        Assert.Equal(normal.TotalSeconds * 1.2, high.TotalSeconds, 3);
    }

    [Theory]
    [InlineData(null, true)]
    [InlineData(408, true)]
    [InlineData(429, true)]
    [InlineData(500, true)]
    [InlineData(503, true)]
    [InlineData(400, false)]
    [InlineData(401, false)]
    [InlineData(403, false)]
    [InlineData(422, false)]
    public void Retryable_status_codes(int? status, bool expected)
        => Assert.Equal(expected, RetryPolicy.IsRetryable(status));
}
