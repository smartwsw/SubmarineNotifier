namespace SubmarineReturnNotifier.Core.Cloud;

/// <summary>指数退避（带抖动的上限截断）。纯函数，便于测试。</summary>
public static class RetryPolicy
{
    public static readonly TimeSpan BaseDelay = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan MaxDelay = TimeSpan.FromMinutes(10);
    public const int MaxAttemptsBeforeBackingOff = 10;

    /// <summary>
    /// 第 <paramref name="attempt"/> 次失败（从 1 开始）后的等待时间：
    /// 5s, 10s, 20s, 40s, 80s, 160s, 320s, 600s 封顶。
    /// </summary>
    public static TimeSpan DelayForAttempt(int attempt)
    {
        if (attempt <= 0) return TimeSpan.Zero;
        var seconds = BaseDelay.TotalSeconds * Math.Pow(2, Math.Min(attempt - 1, 16));
        return TimeSpan.FromSeconds(Math.Min(seconds, MaxDelay.TotalSeconds));
    }

    /// <summary>在基础延迟上加入 ±20% 抖动，避免多客户端同时重试。</summary>
    public static TimeSpan DelayForAttempt(int attempt, int jitterPercent)
    {
        var baseDelay = DelayForAttempt(attempt);
        var clamped = Math.Clamp(jitterPercent, -20, 20);
        return TimeSpan.FromMilliseconds(baseDelay.TotalMilliseconds * (100 + clamped) / 100.0);
    }

    /// <summary>
    /// 判断 HTTP 状态是否值得重试：
    ///  - 网络异常（无状态码）→ 重试
    ///  - 401/403 → 不重试（token 无效，需要用户干预）
    ///  - 400/413/422 → 不重试（数据问题）
    ///  - 408/429/5xx → 重试
    /// </summary>
    public static bool IsRetryable(int? statusCode)
    {
        if (statusCode is null) return true;
        return statusCode is 408 or 429 || statusCode >= 500;
    }
}
