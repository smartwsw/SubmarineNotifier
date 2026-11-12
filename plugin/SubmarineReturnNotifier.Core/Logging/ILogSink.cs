namespace SubmarineReturnNotifier.Core.Logging;

/// <summary>
/// 最小日志抽象。Core 与上传链路只依赖这个接口，
/// 因此无需 Dalamud 即可在单元测试中驱动它们。
/// 实现方必须保证不会把凭据写入日志。
/// </summary>
public interface ILogSink
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
    void Debug(string message);
}

/// <summary>测试与"无日志"场景使用的空实现。</summary>
public sealed class NullLogSink : ILogSink
{
    public static readonly NullLogSink Instance = new();
    public void Info(string message) { }
    public void Warn(string message) { }
    public void Error(string message) { }
    public void Debug(string message) { }
}
