using Dalamud.Plugin.Services;
using SubmarineReturnNotifier.Core.Logging;
using SubmarineReturnNotifier.Core.Utilities;

namespace SubmarineReturnNotifier.Utilities;

/// <summary>
/// 插件日志入口：写日志前统一走 <see cref="Redaction"/>，避免凭据以明文落盘。
/// </summary>
public sealed class Logger : ILogSink
{
    private readonly IPluginLog _log;

    public Logger(IPluginLog log)
    {
        _log = log;
    }

    public void Info(string message) => _log.Information(Redaction.Apply(message));
    public void Warn(string message) => _log.Warning(Redaction.Apply(message));
    public void Error(string message) => _log.Error(Redaction.Apply(message));
    public void Debug(string message) => _log.Debug(Redaction.Apply(message));

    public static string Redact(string message) => Redaction.Apply(message);
}
