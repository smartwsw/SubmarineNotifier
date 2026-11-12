using SubmarineReturnNotifier.Core.Storage;

namespace SubmarineReturnNotifier.Core.Cloud;

public enum UploadDecision
{
    Skip = 0,
    Upload = 1,
}

public sealed record UploadPlan
{
    public required UploadDecision Decision { get; init; }
    public TimeSpan? Delay { get; init; }
    public string? Reason { get; init; }

    public static UploadPlan Skip(string reason) => new() { Decision = UploadDecision.Skip, Reason = reason };
    public static UploadPlan Now(string reason) => new() { Decision = UploadDecision.Upload, Reason = reason };
    public static UploadPlan Later(TimeSpan delay, string reason) => new() { Decision = UploadDecision.Skip, Delay = delay, Reason = reason };
}

/// <summary>
/// 决定"现在是否要发起一次上传"，以及失败后何时重试。
/// 把时间依赖显式传入，方便单元测试。
/// </summary>
public static class UploadScheduler
{
    public static UploadPlan Evaluate(
        PendingUpload? pending,
        bool hasToken,
        bool force,
        DateTimeOffset now)
    {
        if (!hasToken) return UploadPlan.Skip("未绑定设备");
        if (force) return UploadPlan.Now("手动上传");

        if (pending is null || !pending.HasPending) return UploadPlan.Skip("无待上传数据");

        if (pending.NextAttemptAt is { } next && next > now)
        {
            return UploadPlan.Later(next - now, "等待退避结束");
        }

        if (pending.Attempts > 0 && pending.LastError is not null)
        {
            return UploadPlan.Now("重试上次失败的上传");
        }

        return UploadPlan.Now("有待上传变化");
    }

    /// <summary>记录一次失败，返回下次可尝试时间。</summary>
    public static DateTimeOffset RecordFailure(PendingUpload pending, string error, DateTimeOffset now, int jitterPercent = 0)
    {
        pending.Attempts += 1;
        pending.LastError = error.Length > 500 ? error[..500] : error;
        var delay = RetryPolicy.DelayForAttempt(pending.Attempts, jitterPercent);
        pending.NextAttemptAt = now + delay;
        return pending.NextAttemptAt.Value;
    }

    /// <summary>记录一次成功：清空重试状态并记录时间与内容哈希。</summary>
    public static void RecordSuccess(PendingUpload pending, string payloadHash, DateTimeOffset now)
    {
        pending.Attempts = 0;
        pending.LastError = null;
        pending.NextAttemptAt = null;
        pending.LastSuccessAt = now;
        pending.LastPayloadHash = payloadHash;
    }

    /// <summary>
    /// 内容是否需要上传：与上次成功上传的哈希比较。
    /// 注意：首次（LastPayloadHash 为空）视为需要上传。
    /// </summary>
    public static bool HasNewContent(PendingUpload pending, string payloadHash)
        => !string.Equals(pending.LastPayloadHash, payloadHash, StringComparison.Ordinal);
}
