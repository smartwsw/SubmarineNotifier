using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Utilities;

namespace SubmarineReturnNotifier.Core.Notification;

/// <summary>
/// 通知内容的本地预览。
///
/// 插件不发送通知——通知由云端在玩家离线后发出。
/// 这里用与云端 <c>formatNotification</c> 相同的规则渲染一次，
/// 让用户在游戏内确认文案是否符合预期（避免"配置完不知道会收到什么"）。
/// </summary>
public static class NotificationPreview
{
    /// <summary>云端默认标题（见 cloud/src/storage/repository.ts 的默认设置）。</summary>
    public const string DefaultTitle = "潜水艇返航";

    private const int MaxBodyLength = 2000;

    /// <summary>
    /// 用当前扫描结果生成"正式返航"通知预览。
    /// </summary>
    public static (string Title, string Body) Build(
        IReadOnlyList<SubmarineSnapshot> submarines,
        string? title,
        string? bodyTemplate,
        string? timeZone = null)
    {
        var lines = submarines
            .Where(s => s.ReturnAt > 0)
            // 与云端 delivery-service 的排序完全一致：先返航时间，再名称（Ordinal）
            .OrderBy(s => s.ReturnAt)
            .ThenBy(s => s.Name, StringComparer.Ordinal)
            .Select(s => new NoticeLine(s.Name, s.ReturnAt))
            .ToList();

        return Format(
            string.IsNullOrWhiteSpace(title) ? DefaultTitle : title!,
            bodyTemplate ?? string.Empty,
            lines,
            advance: false,
            timeZone);
    }

    /// <summary>与云端一致的模板占位符：{count}、{kind}、{submarines}。</summary>
    public static (string Title, string Body) Format(
        string title,
        string bodyTemplate,
        IReadOnlyList<NoticeLine> lines,
        bool advance,
        string? timeZone = null)
    {
        var kindText = advance ? "即将返航" : "已返航";
        var renderedTitle = advance ? $"{title}（即将返航）" : title;
        var count = lines.Count;
        string Stamp(long returnAt) => TimeText.FormatInZone(returnAt, timeZone ?? "UTC");

        if (!string.IsNullOrWhiteSpace(bodyTemplate))
        {
            var rendered = bodyTemplate
                .Replace("{count}", count.ToString(), StringComparison.Ordinal)
                .Replace("{kind}", kindText, StringComparison.Ordinal)
                .Replace(
                    "{submarines}",
                    string.Join("、", lines.Select(l => $"{l.Name} {Stamp(l.ReturnAt)}")),
                    StringComparison.Ordinal);
            return (renderedTitle, Truncate(rendered));
        }

        var header = advance
            ? $"{count} 艘潜水艇将于 {Stamp(lines.Count > 0 ? lines[0].ReturnAt : 0)} 前后返航"
            : $"{count} 艘潜水艇已返航";
        var detail = string.Join(
            '\n',
            lines.Select(l => $"· {l.Name} — {Stamp(l.ReturnAt)}"));
        return (renderedTitle, Truncate($"{header}\n{detail}"));
    }

    private static string Truncate(string value)
        => value.Length <= MaxBodyLength ? value : value[..MaxBodyLength];

    public readonly record struct NoticeLine(string Name, long ReturnAt);
}
