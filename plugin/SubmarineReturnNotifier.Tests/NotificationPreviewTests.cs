using SubmarineReturnNotifier.Core.Notification;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>本地通知预览需与云端渲染规则一致（见 cloud/src/services/notification-service.ts）。</summary>
public class NotificationPreviewTests
{
    private static readonly NotificationPreview.NoticeLine[] Lines =
    {
        new("潜艇一号", TestData.T0 + 3600),
        new("潜艇二号", TestData.T0 + 3900),
    };

    [Fact]
    public void Default_body_lists_every_submarine()
    {
        var (title, body) = NotificationPreview.Format("潜水艇返航", string.Empty, Lines, advance: false);

        Assert.Equal("潜水艇返航", title);
        Assert.Contains("2 艘潜水艇已返航", body);
        Assert.Contains("潜艇一号", body);
        Assert.Contains("潜艇二号", body);
    }

    [Fact]
    public void Advance_title_has_suffix_and_kind_placeholder()
    {
        var (title, body) = NotificationPreview.Format("返航", "{kind}：{count} 艘", Lines, advance: true);

        Assert.Equal("返航（即将返航）", title);
        Assert.Equal("即将返航：2 艘", body);
    }

    [Theory]
    [InlineData("已返航")]
    [InlineData("即将返航")]
    public void Submarines_placeholder_expands_to_names(string kind)
    {
        var (_, body) = NotificationPreview.Format("t", "{submarines}", Lines, advance: kind == "即将返航");

        Assert.Contains("潜艇一号", body);
        Assert.Contains("、", body);
    }

    [Fact]
    public void Body_is_truncated_to_two_thousand_characters()
    {
        var (_, body) = NotificationPreview.Format("t", new string('x', 5000), Lines, advance: false);

        Assert.Equal(2000, body.Length);
    }

    [Fact]
    public void Build_uses_scan_and_skips_docked_submarines()
    {
        var scan = TestData.Scan(
            TestData.CharacterId, TestData.T0, true,
            TestData.Sub(0, name: "在航", returnAt: TestData.T0 + 600),
            TestData.Sub(1, name: "停泊", returnAt: 0, state: Core.Models.SubmarineState.Docked));

        var (_, body) = NotificationPreview.Build(scan.Submarines, null, null);

        Assert.Contains("在航", body);
        Assert.DoesNotContain("停泊", body);
        Assert.Contains("1 艘潜水艇已返航", body);
    }

    [Fact]
    public void Empty_title_falls_back_to_default()
    {
        var (title, _) = NotificationPreview.Build(Array.Empty<Core.Models.SubmarineSnapshot>(), "   ", null);

        Assert.Equal(NotificationPreview.DefaultTitle, title);
    }

    /// <summary>
    /// 与云端 <c>formatInTimeZone</c> 逐字对齐。期望值取自 Node 的
    /// <c>Intl.DateTimeFormat('zh-CN', { timeZone, hour12:false, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })</c>，
    /// Phase 5 联调中实际收到的推送文本为 "11/12 18:30"。
    /// </summary>
    [Fact]
    public void Times_are_rendered_in_the_configured_zone()
    {
        // 2026-11-12 10:30 UTC == 18:30 Asia/Shanghai
        const long instant = 1794479400;
        var lines = new[] { new NotificationPreview.NoticeLine("潜艇", instant) };

        var (_, shanghai) = NotificationPreview.Format("t", "{submarines}", lines, advance: false, "Asia/Shanghai");
        var (_, utc) = NotificationPreview.Format("t", "{submarines}", lines, advance: false, "UTC");

        Assert.Equal("潜艇 11/12 18:30", shanghai);
        Assert.Equal("潜艇 11/12 10:30", utc);
    }

    [Fact]
    public void Unknown_time_zone_falls_back_to_utc_instead_of_throwing()
    {
        var (_, body) = NotificationPreview.Format("t", "{submarines}", Lines, advance: false, "Not/AZone");

        Assert.Contains("潜艇一号", body);
    }
}
