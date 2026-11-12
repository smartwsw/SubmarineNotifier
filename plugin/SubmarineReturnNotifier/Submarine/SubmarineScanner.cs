using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Submarine;
using SubmarineReturnNotifier.Utilities;

namespace SubmarineReturnNotifier.Submarine;

/// <summary>
/// 扫描节流与变化检测的协调者。
///
/// 约束：
///  - 不在每帧读取内存：由 Plugin 的周期性检查按最小间隔触发；
///  - 工坊未加载时不产生"潜艇消失"的误判；
///  - 内容未变化时不上传。
/// </summary>
public sealed class SubmarineScanner
{
    /// <summary>两次实际读取之间的最小间隔（即使事件连续触发）。</summary>
    public static readonly TimeSpan MinScanInterval = TimeSpan.FromSeconds(2);

    private readonly SubmarineProvider _provider;
    private readonly CloudUploader _uploader;
    private readonly Logger _log;

    private DateTimeOffset _lastScanAt = DateTimeOffset.MinValue;
    private ScanResult? _lastResult;

    public SubmarineScanner(SubmarineProvider provider, CloudUploader uploader, Logger log)
    {
        _provider = provider;
        _uploader = uploader;
        _log = log;
    }

    public ScanResult? LastResult => _lastResult;
    public DateTimeOffset LastScanAt => _lastScanAt;

    /// <summary>
    /// 执行一次扫描（受最小间隔限制）。返回是否发现需要上传的变化。
    /// 必须在游戏主线程调用（读取游戏结构体）。
    /// </summary>
    public bool Scan(bool force, out ScanResult? result)
    {
        result = null;
        var now = DateTimeOffset.UtcNow;
        if (!force && now - _lastScanAt < MinScanInterval)
        {
            result = _lastResult;
            return false;
        }

        _lastScanAt = now;

        ScanResult? scan;
        try
        {
            scan = _provider.TryScan();
        }
        catch (Exception ex)
        {
            // 读取游戏结构体出现异常（例如版本不匹配）不能影响游戏
            _log.Error($"[SubmarineReturnNotifier] 扫描潜水艇失败: {ex}");
            return false;
        }

        result = scan;

        if (scan is null)
        {
            _log.Debug("[SubmarineReturnNotifier] 未登录或角色信息不可用，跳过扫描");
            return false;
        }

        if (!scan.WorkshopLoaded)
        {
            _log.Debug("[SubmarineReturnNotifier] 工坊数据尚未加载，保留上次缓存");
            _lastResult = scan;
            return false;
        }

        var previous = _lastResult;
        var payload = SyncPayloadBuilder.Build(scan, now.ToUnixTimeSeconds());
        var hash = Hashing.HashSyncRequest(payload);
        var changed = _uploader.RecordScan(scan, hash);

        if (changed)
        {
            var summary = ChangeDetector.Compare(previous, scan);
            _log.Info($"[SubmarineReturnNotifier] 检测到变化: {summary.Kind} ({string.Join("; ", summary.Details)})");
        }

        _lastResult = scan;
        return changed;
    }

    /// <summary>清除内存中的上次结果（角色切换 / 登出时调用）。</summary>
    public void Reset() => _lastResult = null;
}
