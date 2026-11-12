using System.Text.RegularExpressions;

namespace SubmarineReturnNotifier.Core.Utilities;

/// <summary>
/// 日志打码规则：把形如 API Token 与推送 Key 的片段替换为 ***。
/// 即使某处误把凭据拼进了消息，也不会以明文写入日志文件。
/// </summary>
public static partial class Redaction
{
    public static string Apply(string? message)
    {
        if (string.IsNullOrEmpty(message)) return message ?? string.Empty;
        var result = TokenPattern().Replace(message, "srk_***");
        return UrlKeyPattern().Replace(result, "$1***");
    }

    [GeneratedRegex(@"srk_[A-Za-z0-9_\-]{8,}")]
    private static partial Regex TokenPattern();

    // 推送 Key 通常出现在 URL 路径中：https://api.day.app/<key>/title
    [GeneratedRegex(@"(https?://[^\s/]+/)[A-Za-z0-9_\-]{6,}")]
    private static partial Regex UrlKeyPattern();
}
