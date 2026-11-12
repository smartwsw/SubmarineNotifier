using Dalamud.Game.Command;
using Dalamud.Interface.Windowing;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Notification;
using SubmarineReturnNotifier.Core.Storage;
using SubmarineReturnNotifier.Core.Utilities;
using SubmarineReturnNotifier.Submarine;
using SubmarineReturnNotifier.Utilities;

namespace SubmarineReturnNotifier;

public sealed class Plugin : IDalamudPlugin
{
    private const string CommandName = "/subnotify";

    [PluginService] public static IDalamudPluginInterface PluginInterface { get; private set; } = null!;
    [PluginService] private static IClientState ClientState { get; set; } = null!;
    [PluginService] private static IPlayerState PlayerState { get; set; } = null!;
    [PluginService] private static IFramework Framework { get; set; } = null!;
    [PluginService] private static ICommandManager CommandManager { get; set; } = null!;
    [PluginService] private static IChatGui ChatGui { get; set; } = null!;
    [PluginService] private static IPluginLog PluginLog { get; set; } = null!;

    private readonly Logger _log;
    private readonly Configuration _config;
    private readonly WindowSystem _windowSystem = new("SubmarineReturnNotifier");
    private readonly ConfigWindow _window;

    private readonly LocalCacheFacade _cache;
    private readonly CloudClient _client;
    private readonly CloudUploader _uploader;
    private readonly SubmarineProvider _provider;
    private readonly SubmarineScanner _scanner;
    private readonly CancellationTokenSource _cts = new();

    private DateTimeOffset _lastTick = DateTimeOffset.MinValue;
    private DateTimeOffset _lastScanRequest = DateTimeOffset.MinValue;
    private bool _uploadInFlight;
    private string? _cloudStatus;
    private DateTimeOffset _cloudStatusAt = DateTimeOffset.MinValue;

    public Plugin()
    {
        _log = new Logger(PluginLog);
        _config = PluginInterface.GetPluginConfig() as Configuration ?? new Configuration();
        _config.CacheDirectory = PluginInterface.GetPluginConfigDirectory();

        _cache = new LocalCacheFacade(_config.CacheDirectory);
        // 缓存中的地址可能比配置更新（例如配置被重置但缓存仍在）；以用户配置为准
        if (_config.ApiBaseUrl.Length > 0) _cache.Document.ApiBaseUrl = _config.ApiBaseUrl;
        _client = new CloudClient(_log);
        _client.Configure(_config.ApiBaseUrl, _config.ApiToken);
        _uploader = new CloudUploader(_client, _cache, _log);
        _provider = new SubmarineProvider(ClientState, PlayerState, _log);
        _scanner = new SubmarineScanner(_provider, _uploader, _log);

        _window = new ConfigWindow(this, _config, _scanner, _uploader, _client, _cache, _log);
        _windowSystem.AddWindow(_window);

        PluginInterface.UiBuilder.Draw += _windowSystem.Draw;
        PluginInterface.UiBuilder.OpenConfigUi += ToggleConfigUi;
        PluginInterface.UiBuilder.OpenMainUi += ToggleConfigUi;

        CommandManager.AddHandler(CommandName, new CommandInfo(OnCommand)
        {
            HelpMessage = "打开潜水艇返航通知设置窗口（/subnotify sync 立即上传）",
        });

        ClientState.Login += OnLogin;
        ClientState.Logout += OnLogout;
        ClientState.TerritoryChanged += OnTerritoryChanged;
        Framework.Update += OnFrameworkUpdate;

        if (ClientState.IsLoggedIn)
        {
            _log.Info("[SubmarineReturnNotifier] 插件已加载，将在下次检查时扫描当前角色");
            RequestScan(force: true);
        }
        else
        {
            _log.Info("[SubmarineReturnNotifier] 插件已加载，等待登录");
        }
    }

    internal Configuration Config => _config;
    internal CloudClient Client => _client;
    internal LocalCacheFacade Cache => _cache;
    internal SubmarineScanner Scanner => _scanner;
    internal CloudUploader Uploader => _uploader;

    internal string? CloudStatus => _cloudStatus;
    internal DateTimeOffset CloudStatusAt => _cloudStatusAt;

    public void Dispose()
    {
        Framework.Update -= OnFrameworkUpdate;
        ClientState.Login -= OnLogin;
        ClientState.Logout -= OnLogout;
        ClientState.TerritoryChanged -= OnTerritoryChanged;

        CommandManager.RemoveHandler(CommandName);

        PluginInterface.UiBuilder.Draw -= _windowSystem.Draw;
        PluginInterface.UiBuilder.OpenConfigUi -= ToggleConfigUi;
        PluginInterface.UiBuilder.OpenMainUi -= ToggleConfigUi;

        _cts.Cancel();
        _cts.Dispose();
        _windowSystem.RemoveAllWindows();
        _client.Dispose();

        _log.Info("[SubmarineReturnNotifier] 插件已卸载");
    }

    internal void ToggleConfigUi() => _window.Toggle();

    /// <summary>供配置界面调用的手动扫描（同步执行一次读取，不做网络请求）。</summary>
    internal bool ManualScan()
    {
        var changed = _scanner.Scan(force: true, out _);
        RequestUpload(force: false);
        return changed;
    }

    /// <summary>供配置界面调用的手动上传。</summary>
    internal async Task<UploadResult> ManualUploadAsync()
    {
        // 先读一次，保证上传的是最新数据
        _scanner.Scan(force: true, out _);
        var result = await _uploader.TryUploadAsync(force: true, _cts.Token).ConfigureAwait(false);
        if (!result.IsSuccess) _cache.AddError($"{DateTimeOffset.Now:HH:mm:ss} {result.Message}");
        return result;
    }

    internal async Task<string> RegisterAsync()
    {
        var response = await _client.RegisterAsync(_config.DeviceName, _cts.Token).ConfigureAwait(false);
        if (!response.Success || response.Data is not { } data)
        {
            return "注册失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误");
        }

        await ApplyBindingAsync(data.UserId, data.DeviceId, data.Token, data.TokenPrefix).ConfigureAwait(false);

        _log.Info($"[SubmarineReturnNotifier] 注册成功，设备 {data.DeviceId}，token 前缀 {data.TokenPrefix}");
        return "注册成功，设备已绑定。";
    }

    /// <summary>
    /// 把本机绑定到已有账号（同一用户的多台电脑共用潜水艇数据与推送设置）。
    ///
    /// 需要先用该账号任一设备的 token 完成认证；成功后本机改用新签发的 token 与设备 ID，
    /// 旧设备不受影响。
    /// </summary>
    internal async Task<string> JoinExistingAccountAsync(string existingToken)
    {
        var token = (existingToken ?? string.Empty).Trim();
        if (token.Length == 0) return "请先填入已有设备的 Token";

        var who = await _client.WhoAmIAsync(_cts.Token, token).ConfigureAwait(false);
        if (!who.Success || who.Data is not { } whoData)
        {
            return "无法加入账号：" + DescribeAuthFailure(who);
        }

        var response = await _client.CreateDeviceAsync(_config.DeviceName, _cts.Token, token).ConfigureAwait(false);
        if (!response.Success || response.Data is not { } data)
        {
            return "加入失败：" + DescribeAuthFailure(response);
        }

        await ApplyBindingAsync(whoData.UserId, data.DeviceId, data.Token, data.TokenPrefix).ConfigureAwait(false);

        _log.Info(
            $"[SubmarineReturnNotifier] 已加入已有账号 {whoData.UserId}，新设备 {data.DeviceId}，token 前缀 {data.TokenPrefix}");
        return $"已加入账号 {whoData.UserId}，本机设备 {data.DeviceId}。";
    }

    private static string DescribeAuthFailure<T>(Core.Cloud.CloudResponse<T> response) =>
        response.ErrorCode switch
        {
            "INVALID_TOKEN" or "MISSING_TOKEN" => "填入的 Token 无效或已吊销",
            "FORBIDDEN" => "该 Token 已被吊销",
            "NOT_CONFIGURED" => "未设置 API 地址",
            _ => response.ErrorMessage ?? response.ErrorCode ?? "未知错误",
        };

    /// <summary>写入新的账号绑定，并清掉上一份绑定遗留的待上传数据。</summary>
    private async Task ApplyBindingAsync(string userId, string deviceId, string token, string tokenPrefix)
    {
        // 配置写入与保存必须在框架线程上完成
        await Framework.RunOnFrameworkThread(() =>
        {
            _config.UserId = userId;
            _config.ApiToken = token;
            _config.TokenPrefix = tokenPrefix;
            _config.DeviceId = deviceId;
            _config.Save();

            lock (_cache.SyncRoot)
            {
                _cache.Document.UserId = userId;
                _cache.Document.DeviceId = deviceId;
                _cache.Document.TokenPrefix = tokenPrefix;
                _cache.Document.ApiBaseUrl = _client.BaseUrl;
                // 换了账号/设备后旧账号的待上传数据不能带过去（可能属于另一个用户）
                _cache.Document.Pending = null;
                _cache.Save();
            }

            _client.Configure(_config.ApiBaseUrl, _config.ApiToken);
        }).ConfigureAwait(false);
    }

    internal async Task<string> TestConnectionAsync()
    {
        var health = await _client.HealthAsync(_cts.Token).ConfigureAwait(false);
        if (!health.Success)
        {
            SetCloudStatus("连接失败");
            return "无法连接：" + (health.ErrorMessage ?? health.ErrorCode ?? "未知错误");
        }

        if (health.Success && health.Data is { } healthData) _uploader.NoteServerTime(healthData.ServerTime);

        var status = await _client.GetStatusAsync(_cts.Token).ConfigureAwait(false);
        if (status.Success)
        {
            SetCloudStatus("已连接");
            var pending = status.Data?.Scheduler?.PendingBatches ?? 0;
            return $"连接正常，云端待处理批次 {pending}，服务器时间 {TimeText.FormatLocal(status.Data?.ServerTime ?? 0)}";
        }

        SetCloudStatus(status.Unauthorized ? "认证失败" : "连接异常");
        return "连接异常：" + (status.ErrorMessage ?? status.ErrorCode ?? "未知错误");
    }

    private void SetCloudStatus(string status)
    {
        _cloudStatus = status;
        _cloudStatusAt = DateTimeOffset.UtcNow;
    }

    private void OnCommand(string command, string args)
    {
        var trimmed = (args ?? string.Empty).Trim();
        if (trimmed.Equals("sync", StringComparison.OrdinalIgnoreCase) ||
            trimmed.Equals("upload", StringComparison.OrdinalIgnoreCase))
        {
            RequestUpload(force: true);
            ChatGui.Print("[潜水艇返航通知] 正在上传最新状态…");
            return;
        }

        if (trimmed.Equals("scan", StringComparison.OrdinalIgnoreCase))
        {
            var changed = ManualScan();
            ChatGui.Print(changed ? "[潜水艇返航通知] 已重新扫描，检测到变化" : "[潜水艇返航通知] 已重新扫描，无变化");
            return;
        }

        ToggleConfigUi();
    }

    private void OnLogin()
    {
        _log.Info("[SubmarineReturnNotifier] 检测到登录");
        _scanner.Reset();
        _lastScanRequest = DateTimeOffset.MinValue;
        RequestScan(force: true);
        if (_config.UploadOnLogin) RequestUpload(force: false);
    }

    private void OnLogout(int type, int code)
    {
        _log.Info($"[SubmarineReturnNotifier] 检测到登出（type={type} code={code}），保留上次缓存");
        _scanner.Reset();
    }

    private void OnTerritoryChanged(uint territory)
    {
        // 进入/离开工坊区域后数据可能更新；由 Scan 的最小间隔节流
        RequestScan(force: false);
    }

    private void RequestScan(bool force)
    {
        if (!force && DateTimeOffset.UtcNow - _lastScanRequest < SubmarineScanner.MinScanInterval) return;
        _lastScanRequest = DateTimeOffset.UtcNow;
        _scanner.Scan(force: force, out _);
    }

    private void OnFrameworkUpdate(IFramework framework)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastTick < CurrentPollInterval) return;
        _lastTick = now;

        if (ClientState.IsLoggedIn) RequestScan(force: false);
        RequestUpload(force: false);
    }

    /// <summary>用户可在诊断页调整自动检查间隔（10 秒 ~ 1 小时）。</summary>
    private TimeSpan CurrentPollInterval => TimeSpan.FromSeconds(
        Math.Clamp(_config.AutoScanIntervalSeconds, 10, 3600));

    /// <summary>在后台启动一次上传；绝不在主线程同步等待。</summary>
    internal void RequestUpload(bool force)
    {
        if (_uploadInFlight) return;

        lock (_cache.SyncRoot)
        {
            if (!force && !_uploader.CanUploadNow(force: false)) return;
        }

        _uploadInFlight = true;
        var token = _cts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                var result = await _uploader.TryUploadAsync(force, token).ConfigureAwait(false);
                if (result.Outcome is UploadOutcome.Failed or UploadOutcome.NotConfigured)
                {
                    _cache.AddError($"{DateTimeOffset.Now:HH:mm:ss} {result.Message}");
                    if (_config.ShowDebugLog) _log.Warn($"[SubmarineReturnNotifier] 上传未完成：{result.Message}");
                }
                else if (result.IsSuccess)
                {
                    SetCloudStatus("已连接");
                }
            }
            catch (OperationCanceledException)
            {
                // 插件卸载
            }
            catch (Exception ex)
            {
                _log.Error($"[SubmarineReturnNotifier] 后台上传异常: {ex.Message}");
            }
            finally
            {
                _uploadInFlight = false;
            }
        }, token);
    }
}
