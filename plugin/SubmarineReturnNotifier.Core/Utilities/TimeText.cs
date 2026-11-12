namespace SubmarineReturnNotifier.Core.Utilities;

/// <summary>把绝对 Unix 秒转换为本地时间文本（用于界面展示）。</summary>
public static class TimeText
{
    public static string FormatLocal(long unixSeconds)
    {
        if (unixSeconds <= 0) return "—";
        var local = DateTimeOffset.FromUnixTimeSeconds(unixSeconds).ToLocalTime();
        return local.ToString("MM-dd HH:mm");
    }

    /// <summary>
    /// 按指定 IANA 时区格式化，输出与云端 <c>formatInTimeZone</c>（Intl，zh-CN，MM/dd HH:mm）完全一致，
    /// 让插件内的预览与实际收到的推送逐字对应。
    /// </summary>
    public static string FormatInZone(long unixSeconds, string timeZone)
    {
        if (unixSeconds <= 0) return "—";
        var utc = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
        var tz = ResolveZone(timeZone) ?? TimeZoneInfo.Utc;
        return TimeZoneInfo.ConvertTime(utc, tz).ToString("MM'/'dd HH:mm");
    }

    /// <summary>时区 ID 无法识别时返回 null（不是所有运行环境都有完整 IANA 数据库）。</summary>
    public static TimeZoneInfo? ResolveZone(string? timeZone)
    {
        if (string.IsNullOrWhiteSpace(timeZone)) return null;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(timeZone);
        }
        catch (TimeZoneNotFoundException)
        {
            return null;
        }
        catch (InvalidTimeZoneException)
        {
            return null;
        }
    }

    public static string FormatRemaining(long unixSeconds, long nowUnix)
    {
        if (unixSeconds <= 0) return "未出航";
        var remaining = unixSeconds - nowUnix;
        if (remaining <= 0) return "已返航";

        var span = TimeSpan.FromSeconds(remaining);
        if (span.TotalDays >= 1) return $"{(int)span.TotalDays} 天 {span.Hours} 小时";
        if (span.TotalHours >= 1) return $"{(int)span.TotalHours} 小时 {span.Minutes} 分";
        return $"{span.Minutes} 分 {span.Seconds} 秒";
    }
}
