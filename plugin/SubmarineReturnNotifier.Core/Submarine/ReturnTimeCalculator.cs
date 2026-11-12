using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Core.Submarine;

/// <summary>
/// 状态判定的纯函数集合。
///
/// 返航时间本身来自游戏客户端的 <c>ReturnTime</c> 字段（服务器同步的绝对 Unix 秒），
/// 这里不做"从出发时间推算"；只负责：
///  - 由返航时间与当前时刻推导状态；
///  - 校验时间的合理性（防止脏数据污染云端排程）。
/// </summary>
public static class ReturnTimeCalculator
{
    public const long MaxVoyageSeconds = 7 * 24 * 60 * 60;
    public const long MaxPastOffsetSeconds = 7 * 24 * 60 * 60;
    public const int MaxSlots = 4;

    /// <summary>由返航时间推导状态：0 = 停靠，未来 = 航行中，过去 = 已返航。</summary>
    public static SubmarineState DeriveState(long returnAtUnix, long nowUnix)
    {
        if (returnAtUnix <= 0) return SubmarineState.Docked;
        return returnAtUnix > nowUnix ? SubmarineState.Sailing : SubmarineState.Returned;
    }

    /// <summary>返航时间的合理性校验。0 始终有效。</summary>
    public static bool IsPlausibleReturnTime(long returnAtUnix, long nowUnix)
    {
        if (returnAtUnix == 0) return true;
        if (returnAtUnix < nowUnix - MaxPastOffsetSeconds) return false;
        if (returnAtUnix > nowUnix + MaxVoyageSeconds) return false;
        return true;
    }

    public static long RemainingSeconds(long returnAtUnix, long nowUnix)
        => returnAtUnix <= 0 ? 0 : Math.Max(0, returnAtUnix - nowUnix);
}
