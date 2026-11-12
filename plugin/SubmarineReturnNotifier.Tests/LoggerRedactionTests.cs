using SubmarineReturnNotifier.Core.Utilities;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>日志不得泄露 Token / Bark Key（对应 TODO §11 "日志泄露"检查与 §16 约束 7）。</summary>
public class LoggerRedactionTests
{
    [Fact]
    public void Api_tokens_are_masked()
    {
        var redacted = Redaction.Apply("token=srk_abcdefghijklmnopqrstuvwx sent");

        Assert.DoesNotContain("abcdefghijklmnop", redacted);
        Assert.Contains("srk_***", redacted);
    }

    [Fact]
    public void Bark_device_keys_in_urls_are_masked()
    {
        var redacted = Redaction.Apply("push https://api.day.app/AbCdEfGhIjKlMnOp/文本");

        Assert.DoesNotContain("AbCdEfGhIjKlMnOp", redacted);
        Assert.Contains("api.day.app/***", redacted);
    }

    [Fact]
    public void Ordinary_text_is_unchanged()
    {
        const string message = "扫描到 3 艘潜水艇（角色 abc）";
        Assert.Equal(message, Redaction.Apply(message));
    }

    [Fact]
    public void Empty_message_is_safe()
        => Assert.Equal(string.Empty, Redaction.Apply(string.Empty));
}
