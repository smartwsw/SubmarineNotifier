using System.Numerics;
using Dalamud.Interface.Windowing;
// Dalamud API 15 起，ImGui 绑定从 ImGuiNET 迁移到 Dalamud.Bindings.ImGui，
// 且字符串参数改为 ImU8String（string 有隐式转换）。
using Dalamud.Bindings.ImGui;
using SubmarineReturnNotifier.Core.Logging;
using SubmarineReturnNotifier.Core.Storage;
using SubmarineReturnNotifier.Core.Utilities;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Submarine;
using SubmarineReturnNotifier.Core.Notification;
using SubmarineReturnNotifier.Submarine;
using SubmarineReturnNotifier.Utilities;

namespace SubmarineReturnNotifier;

/// <summary>
/// 设置与状态窗口。
///
/// 所有网络操作都是异步的：按钮只启动任务，结果回写到字段，绝不阻塞界面或游戏线程。
/// Bark Device Key 只作为草稿发送给云端，云端不回传，界面也不会把它写到日志。
/// </summary>
public sealed class ConfigWindow : Window
{
    private readonly Plugin _plugin;
    private readonly Configuration _config;
    private readonly SubmarineScanner _scanner;
    private readonly CloudUploader _uploader;
    private readonly CloudClient _client;
    private readonly ICacheStore _cache;
    private readonly Logger _log;

    private string _apiUrl;
    private string _deviceName;

    // 推送设置草稿（从云端读取，用户修改后提交）
    private string _draftServerUrl = string.Empty;
    private string _draftDeviceKey = string.Empty;
    private string _draftTopic = string.Empty;
    private string _draftTitle = string.Empty;
    private string _draftBody = string.Empty;
    private string _draftTimezone = "Asia/Shanghai";
    private int _draftMergeWindow = 10;
    private int _draftAdvance;
    private int _draftProvider;      // 0=bark 1=ntfy 2=none
    private bool _draftEnabled = true;
    private bool _settingsLoaded;
    private bool _providerConfigured;

    private string _status = string.Empty;
    private bool _statusIsError;
    private bool _busy;
    private bool _confirmDelete;

    // 「加入已有账号」草稿：粘贴另一台设备已有的 token，把本机绑定到同一用户
    private string _joinToken = string.Empty;

    public ConfigWindow(
        Plugin plugin,
        Configuration config,
        SubmarineScanner scanner,
        CloudUploader uploader,
        CloudClient client,
        ICacheStore cache,
        Logger log)
        : base("潜水艇返航通知###SubmarineReturnNotifierConfig", ImGuiWindowFlags.NoCollapse)
    {
        _plugin = plugin;
        _config = config;
        _scanner = scanner;
        _uploader = uploader;
        _client = client;
        _cache = cache;
        _log = log;

        _apiUrl = config.ApiBaseUrl;
        _deviceName = config.DeviceName;

        Size = new Vector2(560, 620);
        SizeCondition = ImGuiCond.FirstUseEver;
    }

    public override void OnOpen()
    {
        _apiUrl = _config.ApiBaseUrl;
        _deviceName = _config.DeviceName;
        if (_config.ApiToken.Length > 0 && _config.ApiBaseUrl.Length > 0) _ = LoadSettingsAsync();
    }

    public override void Draw()
    {
        if (!ImGui.BeginTabBar("##tabs")) return;
        if (ImGui.BeginTabItem("状态")) { DrawStatusTab(); ImGui.EndTabItem(); }
        if (ImGui.BeginTabItem("绑定")) { DrawBindingTab(); ImGui.EndTabItem(); }
        if (ImGui.BeginTabItem("推送")) { DrawPushTab(); ImGui.EndTabItem(); }
        if (ImGui.BeginTabItem("诊断")) { DrawDiagnosticsTab(); ImGui.EndTabItem(); }
        ImGui.EndTabBar();
    }

    // ---------------- 状态 ----------------

    private void DrawStatusTab()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var scan = _scanner.LastResult;

        ImGui.Spacing();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "当前角色");
        if (scan is null)
        {
            ImGui.TextDisabled("尚未扫描（未登录或工坊数据未加载）");
        }
        else
        {
            ImGui.TextUnformatted($"{scan.CharacterName}  (ID {scan.CharacterId})");
            if (!scan.WorkshopLoaded)
            {
                var cached = _cache.Document.LastScan;
                ImGui.TextDisabled(cached is null
                    ? "工坊数据未加载，本机还没有缓存结果"
                    : $"工坊数据未加载，展示的是本机缓存（采集于 {TimeText.FormatLocal(cached.CollectedAt)}）");
                // 同一账号可能刚在别处出航：那台设备的记录只有云端有，本机缓存反而是旧的
                ImGui.TextColored(
                    new Vector4(1f, 0.8f, 0.4f, 1f),
                    "未打开工坊面板时，本机读到的是旧数据。若刚在别的电脑上出航/收艇，" +
                    "请打开一次工坊→潜水艇面板；云端会自动保留较新的那份记录。");
            }
        }

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "潜水艇");

        var rows = scan?.WorkshopLoaded == true ? scan.Submarines : _cache.Document.LastScan?.Submarines ?? new List<SubmarineSnapshot>();
        if (rows.Count == 0)
        {
            ImGui.TextDisabled("没有可显示的潜水艇数据");
        }
        else if (ImGui.BeginTable("##subs", 4, ImGuiTableFlags.Borders | ImGuiTableFlags.RowBg | ImGuiTableFlags.SizingStretchProp))
        {
            ImGui.TableSetupColumn("名称");
            ImGui.TableSetupColumn("状态");
            ImGui.TableSetupColumn("返航时间");
            ImGui.TableSetupColumn("剩余");
            ImGui.TableHeadersRow();

            foreach (var sub in rows.OrderBy(s => s.SlotIndex))
            {
                ImGui.TableNextRow();
                ImGui.TableNextColumn();
                ImGui.TextUnformatted(sub.Name);

                ImGui.TableNextColumn();
                var state = ReturnTimeCalculator.DeriveState(sub.ReturnAt, now);
                ImGui.TextUnformatted(StateText(state));

                ImGui.TableNextColumn();
                ImGui.TextUnformatted(TimeText.FormatLocal(sub.ReturnAt));

                ImGui.TableNextColumn();
                ImGui.TextUnformatted(TimeText.FormatRemaining(sub.ReturnAt, now));
            }
            ImGui.EndTable();
        }

        var nextReturn = rows.Where(s => s.ReturnAt > now).Select(s => s.ReturnAt).DefaultIfEmpty(0).Min();
        ImGui.Spacing();
        ImGui.TextUnformatted(nextReturn > 0
            ? $"下次返航：{TimeText.FormatLocal(nextReturn)}（{TimeText.FormatRemaining(nextReturn, now)}）"
            : "下次返航：暂无（没有在航的潜水艇）");

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "上传状态");
        var lastSuccess = _uploader.LastSuccessAt;
        ImGui.TextUnformatted("上次成功上传：" + (lastSuccess is null ? "从未" : lastSuccess.Value.ToLocalTime().ToString("MM-dd HH:mm:ss")));

        var pending = _cache.Document.Pending;
        if (pending is { Attempts: > 0 } && pending.LastError is { } err)
        {
            ImGui.TextColored(new Vector4(1f, 0.6f, 0.4f, 1f), $"最近一次失败：{err}");
            if (_uploader.NextAttemptAt is { } next)
                ImGui.TextUnformatted($"下次自动重试：{next.ToLocalTime():HH:mm:ss}");
        }
        else
        {
            ImGui.TextDisabled(pending?.HasPending == true ? "有待上传的变化" : "没有待上传的变化");
        }

        var cloud = _plugin.CloudStatus;
        ImGui.TextUnformatted("云端连接：" + (cloud ?? "未检测") + (cloud is null ? string.Empty : $"（{_plugin.CloudStatusAt.ToLocalTime():HH:mm:ss}）"));

        ImGui.Spacing();
        if (ImGui.Button("手动刷新"))
        {
            var changed = _plugin.ManualScan();
            SetStatus(changed ? "已重新扫描，检测到变化" : "已重新扫描，无变化", false);
        }
        ImGui.SameLine();
        if (ImGui.Button("手动上传")) RunAsync(_plugin.ManualUploadAsync, r => r.IsSuccess ? "上传完成：" + r.Message : "上传失败：" + r.Message);
        ImGui.SameLine();
        if (ImGui.Button("检查云端")) RunAsync(() => _plugin.TestConnectionAsync(), s => s);

        DrawStatusLine();
    }

    private static string StateText(SubmarineState state) => state switch
    {
        SubmarineState.Sailing => "航行中",
        SubmarineState.Returned => "已返航",
        SubmarineState.Docked => "停泊",
        _ => "未知",
    };

    /// <summary>
    /// 画一个占满整行的输入框：标题在上方、说明在下方。
    ///
    /// ImGui 的 InputText 会把 label 画在控件右侧，而 <c>SetNextItemWidth(-1)</c> 已经占满整行，
    /// label 会被挤出可视区域（界面上表现为"输入框没有名字"）。所以 label 改用独立的 Text 绘制，
    /// 控件本身用 <c>##id</c> 隐藏 label。
    /// </summary>
    private static bool FullWidthInput(string label, string id, ref string value, int maxLength, string? hint = null)
    {
        ImGui.TextUnformatted(label);
        ImGui.SetNextItemWidth(-1);
        var changed = ImGui.InputText("##" + id, ref value, maxLength);
        if (!string.IsNullOrEmpty(hint)) ImGui.TextDisabled(hint);
        ImGui.Spacing();
        return changed;
    }

    // ---------------- 绑定 ----------------

    private void DrawBindingTab()
    {
        ImGui.Spacing();
        ImGui.TextWrapped("插件只上传潜水艇状态；通知由云端在潜水艇返航时推送到手机。");
        ImGui.Spacing();

        FullWidthInput(
            "Cloudflare Worker 地址", "apiurl", ref _apiUrl, 512,
            "例如 https://submarine-notifier.你的账号.workers.dev");

        FullWidthInput("设备名称", "devicename", ref _deviceName, 64, "仅用于在云端区分多个客户端");

        ImGui.Spacing();
        if (ImGui.Button("保存地址")) SaveEndpoint();
        ImGui.SameLine();
        if (ImGui.Button(_busy ? "注册中…" : "注册新设备"))
        {
            SaveEndpoint();
            RunAsync(_plugin.RegisterAsync, s => s);
        }
        ImGui.SameLine();
        if (ImGui.Button("连接测试")) RunAsync(() => _plugin.TestConnectionAsync(), s => s);

        ImGui.Spacing();
        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "加入已有账号（多台电脑共用）");
        ImGui.TextWrapped(
            "在另一台已绑定的电脑上打开此窗口，复制它的完整 Token 填到下面，" +
            "本机就会作为新设备并入同一个账号 —— 潜水艇数据、推送设置、通知历史都是同一份。");
        ImGui.TextDisabled("「注册新设备」会创建一个全新的独立账号；只有第一次使用某个账号时才点它。");

        ImGui.TextUnformatted("已有设备的 Token");
        ImGui.SetNextItemWidth(-1);
        ImGui.InputText("##jointoken", ref _joinToken, 256);
        if (ImGui.Button(_busy ? "处理中…" : "加入已有账号"))
        {
            SaveEndpoint();
            var token = _joinToken.Trim();
            _joinToken = string.Empty;
            RunAsync(() => _plugin.JoinExistingAccountAsync(token), s => s);
        }

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "身份信息");
        ImGui.TextUnformatted("用户 ID：" + (string.IsNullOrEmpty(_config.UserId) ? "未注册" : _config.UserId));
        ImGui.TextUnformatted("设备 ID：" + (string.IsNullOrEmpty(_config.DeviceId) ? "未绑定" : _config.DeviceId));
        ImGui.TextUnformatted("Token：" + (string.IsNullOrEmpty(_config.TokenPrefix)
            ? "无"
            : _config.TokenPrefix + "…（已保存在插件配置中；云端只保存哈希，无法找回完整值）"));

        ImGui.Spacing();
        if (ImGui.Button("复制用户 ID")) ImGui.SetClipboardText(_config.UserId);
        ImGui.SameLine();
        if (ImGui.Button("复制 Token")) ImGui.SetClipboardText(_config.ApiToken);
        if (ImGui.IsItemHovered())
            ImGui.SetTooltip("用于在另一台电脑上「加入已有账号」。只粘贴到自己的设备，不要发给别人。");
        ImGui.SameLine();
        if (ImGui.Button(_confirmDelete ? "确认删除云端账号" : "删除云端账号"))
        {
            if (!_confirmDelete) { _confirmDelete = true; }
            else
            {
                _confirmDelete = false;
                RunAsync(DeleteAccountAsync, s => s);
            }
        }
        if (_confirmDelete) ImGui.TextColored(new Vector4(1f, 0.5f, 0.4f, 1f), "再次点击将永久删除云端数据（潜水艇记录、推送配置、通知历史）");

        DrawStatusLine();
    }

    private void SaveEndpoint()
    {
        var normalized = CloudClient.NormalizeBase(_apiUrl);
        if (normalized.Length == 0)
        {
            SetStatus("API 地址无效", true);
            return;
        }

        _apiUrl = normalized;
        _config.ApiBaseUrl = normalized;
        _config.DeviceName = string.IsNullOrWhiteSpace(_deviceName) ? "FF14 客户端" : _deviceName.Trim();
        _config.Save();
        _client.Configure(_config.ApiBaseUrl, _config.ApiToken);
        lock (_cache.SyncRoot)
        {
            _cache.Document.ApiBaseUrl = normalized;
            _cache.Save();
        }
        SetStatus("地址已保存", false);
    }

    private async Task<string> DeleteAccountAsync()
    {
        var response = await _client.DeleteAccountAsync(CancellationToken.None).ConfigureAwait(false);
        if (!response.Success)
            return "删除失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误");

        _config.ApiToken = string.Empty;
        _config.UserId = string.Empty;
        _config.DeviceId = string.Empty;
        _config.TokenPrefix = string.Empty;
        _config.Save();
        _client.Configure(_config.ApiBaseUrl, string.Empty);
        _settingsLoaded = false;
        return "云端账号已删除，本地绑定信息已清除";
    }

    // ---------------- 推送 ----------------

    private void DrawPushTab()
    {
        if (!_settingsLoaded)
        {
            ImGui.Spacing();
            ImGui.TextWrapped("读取推送设置需要已绑定的设备。请先在「绑定」页完成注册。");
            if (ImGui.Button("读取云端设置")) _ = LoadSettingsAsync();
            DrawStatusLine();
            return;
        }

        ImGui.Spacing();
        var enabled = _draftEnabled;
        if (ImGui.Checkbox("启用返航通知", ref enabled)) _draftEnabled = enabled;

        var providers = new[] { "Bark", "ntfy", "不推送" };
        ImGui.SetNextItemWidth(180);
        if (ImGui.Combo("推送方式", ref _draftProvider, providers, providers.Length)) { }

        ImGui.Spacing();
        if (_draftProvider == 0)
        {
            FullWidthInput(
                "Bark Server URL", "barkurl", ref _draftServerUrl, 512,
                "默认 https://api.day.app；使用自建服务时填写自己的地址");

            ImGui.TextUnformatted("Bark Device Key");
            ImGui.SetNextItemWidth(-1);
            ImGui.InputText("##barkkey", ref _draftDeviceKey, 512);
            ImGui.TextColored(
                new Vector4(0.7f, 0.7f, 0.7f, 1f),
                _providerConfigured
                    ? "已保存 Key（云端加密存储，不回传明文）。留空表示不修改。"
                    : "Key 只发送到云端加密保存，插件不会再次读取它。");
            ImGui.Spacing();

            FullWidthInput(
                "通知分组（可选）", "barkgroup", ref _draftTopic, 64,
                "iPhone 上 Bark 把通知归到哪个分组列表；留空使用默认分组。不影响是否发送");

            if (ImGui.Button("测试推送"))
            {
                var key = _draftDeviceKey.Trim();
                RunAsync(
                    () => TestPushAsync("bark", _draftServerUrl, key, null),
                    s => s);
            }
            ImGui.SameLine();
            if (ImGui.Button("保存并测试")) RunAsync(SaveThenTestAsync, s => s);
            ImGui.SameLine();
            if (ImGui.Button("保存推送设置")) RunAsync(SaveSettingsAsync, s => s);
        }
        else if (_draftProvider == 1)
        {
            FullWidthInput(
                "ntfy Server URL", "ntfyurl", ref _draftServerUrl, 512,
                "默认 https://ntfy.sh；私有服务器请填写自己的地址");

            FullWidthInput(
                "Topic", "ntfytopic", ref _draftTopic, 64,
                "建议同时配置 Access Token，避免公开 Topic 被他人读取");

            FullWidthInput(
                "Access Token", "ntfytoken", ref _draftDeviceKey, 512,
                _providerConfigured ? "已保存（留空表示不修改）" : "未配置");

            if (ImGui.Button("测试推送")) RunAsync(() => TestPushAsync("ntfy", _draftServerUrl, _draftDeviceKey.Trim(), _draftTopic.Trim()), s => s);
            ImGui.SameLine();
            if (ImGui.Button("保存推送设置")) RunAsync(SaveSettingsAsync, s => s);
        }
        else
        {
            ImGui.TextDisabled("当前不发送任何通知。");
            if (ImGui.Button("保存推送设置")) RunAsync(SaveSettingsAsync, s => s);
        }

        ImGui.Spacing();
        if (ImGui.Button("立即发送下次返航")) RunAsync(PushNextAsync, s => s);
        ImGui.SameLine();
        ImGui.TextDisabled("用云端已排定的真实批次内容立刻推送一条，不改动原本的发送计划");

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "通知规则");
        ImGui.SetNextItemWidth(160);
        if (ImGui.SliderInt("合并窗口（分钟）", ref _draftMergeWindow, 0, 120)) { }
        ImGui.TextDisabled("返航时间相近的潜水艇合并为一条通知；0 表示每条单独推送");

        var advanceOptions = new[] { 0, 1, 5, 10, 15, 30 };
        var advanceLabels = new[] { "关闭", "提前 1 分钟", "提前 5 分钟", "提前 10 分钟", "提前 15 分钟", "提前 30 分钟" };
        var advanceIndex = Math.Max(0, Array.IndexOf(advanceOptions, _draftAdvance));
        if (ImGui.Combo("提前通知", ref advanceIndex, advanceLabels, advanceLabels.Length))
            _draftAdvance = advanceOptions[advanceIndex];

        FullWidthInput("通知标题", "title", ref _draftTitle, 120, "留空使用默认标题「潜水艇返航」");

        ImGui.TextUnformatted("正文模板");
        ImGui.SetNextItemWidth(-1);
        ImGui.InputTextMultiline("##body", ref _draftBody, 2000, new Vector2(-1, 60));
        ImGui.TextDisabled("可用占位符：{count} 数量、{kind} 已返航/即将返航、{submarines} 潜水艇列表；留空使用默认模板");
        ImGui.Spacing();

        ImGui.TextUnformatted("时区");
        ImGui.SetNextItemWidth(-1);
        ImGui.InputText("##timezone", ref _draftTimezone, 64);
        if (Core.Utilities.TimeText.ResolveZone(_draftTimezone) is null)
            ImGui.TextColored(new Vector4(1f, 0.6f, 0.4f, 1f), "无法识别该时区，将按 UTC 显示；云端也会拒绝未知时区");
        else
            ImGui.TextDisabled("IANA 时区名，例如 Asia/Shanghai");
        ImGui.Spacing();

        var preview = BuildPreview();
        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "预览");
        ImGui.TextWrapped(preview.Title);
        ImGui.TextWrapped(preview.Body);

        ImGui.Spacing();
        if (ImGui.Button("保存全部设置")) RunAsync(SaveSettingsAsync, s => s);
        ImGui.SameLine();
        if (ImGui.Button("从云端重新读取")) _ = LoadSettingsAsync();

        DrawStatusLine();
    }

    private (string Title, string Body) BuildPreview()
    {
        var subs = _scanner.LastResult?.Submarines ?? Array.Empty<SubmarineSnapshot>();
        if (subs.Count == 0)
        {
            var sample = new[]
            {
                new NotificationPreview.NoticeLine("示例潜水艇 A", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3600),
                new NotificationPreview.NoticeLine("示例潜水艇 B", DateTimeOffset.UtcNow.ToUnixTimeSeconds() + 3900),
            };
            return NotificationPreview.Format(
                string.IsNullOrWhiteSpace(_draftTitle) ? NotificationPreview.DefaultTitle : _draftTitle,
                _draftBody, sample, advance: false, _draftTimezone);
        }

        return NotificationPreview.Build(subs, _draftTitle, _draftBody, _draftTimezone);
    }

    private async Task LoadSettingsAsync()
    {
        var response = await _client.GetSettingsAsync(CancellationToken.None).ConfigureAwait(false);
        if (!response.Success || response.Data is not { } s)
        {
            SetStatus("读取设置失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误"), true);
            return;
        }

        _draftProvider = s.Provider switch { "bark" => 0, "ntfy" => 1, _ => 2 };
        _draftServerUrl = s.ProviderServerUrl;
        _draftTopic = s.Provider == "ntfy" ? s.ProviderTopic : s.NotifyGroup;
        _draftTitle = s.NotifyTitle;
        _draftBody = s.NotifyBodyTemplate;
        _draftTimezone = s.Timezone;
        _draftMergeWindow = s.MergeWindowMinutes;
        _draftAdvance = s.AdvanceNotificationMinutes;
        _draftEnabled = s.NotificationEnabled;
        _providerConfigured = s.ProviderConfigured;
        _draftDeviceKey = string.Empty;   // 云端不回传明文
        _settingsLoaded = true;
        SetStatus("已读取云端设置", false);
    }

    private async Task<string> SaveSettingsAsync()
    {
        var provider = _draftProvider switch { 0 => "bark", 1 => "ntfy", _ => "none" };
        var key = _draftDeviceKey.Trim();
        var patch = new SettingsPatchDto
        {
            MergeWindowMinutes = _draftMergeWindow,
            AdvanceNotificationMinutes = _draftAdvance,
            NotificationEnabled = _draftEnabled,
            Provider = provider,
            ProviderServerUrl = _draftServerUrl.Trim(),
            ProviderTopic = provider == "ntfy" ? _draftTopic.Trim() : string.Empty,
            NotifyGroup = provider == "bark" ? _draftTopic.Trim() : string.Empty,
            NotifyTitle = _draftTitle,
            NotifyBodyTemplate = _draftBody,
            Timezone = _draftTimezone,
            ProviderToken = key.Length > 0 ? key : null, // 留空表示保留云端原值
        };

        var response = await _client.PutSettingsAsync(patch, CancellationToken.None).ConfigureAwait(false);
        if (!response.Success)
            return "保存失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误");

        _draftDeviceKey = string.Empty;
        _providerConfigured = response.Data?.ProviderConfigured ?? _providerConfigured;
        return "推送设置已保存";
    }

    private async Task<string> SaveThenTestAsync()
    {
        var saved = await SaveSettingsAsync().ConfigureAwait(false);
        if (!saved.StartsWith("推送设置已保存", StringComparison.Ordinal)) return saved;
        var test = await TestPushAsync("bark", _draftServerUrl, null, null).ConfigureAwait(false);
        return saved + "；" + test;
    }

    /// <summary>
    /// 测试推送。<paramref name="deviceKey"/> 为 null 时使用云端已保存的配置
    /// （因此界面上不再回显明文）。
    /// </summary>
    private async Task<string> TestPushAsync(string provider, string serverUrl, string? deviceKey, string? topic)
    {
        var request = new TestPushRequestDto
        {
            Provider = provider,
            ServerUrl = string.IsNullOrWhiteSpace(serverUrl) ? null : serverUrl.Trim(),
            DeviceKey = string.IsNullOrWhiteSpace(deviceKey) ? null : deviceKey,
            Topic = string.IsNullOrWhiteSpace(topic) ? null : topic,
        };

        var response = await _client.TestPushAsync(request, CancellationToken.None).ConfigureAwait(false);
        if (!response.Success)
            return "测试推送失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误");

        return $"测试推送已发送（{response.Data?.Provider}，{response.Data?.LatencyMs} ms）";
    }

    /// <summary>让云端按已排定的下一批次内容立即推送一条。</summary>
    private async Task<string> PushNextAsync()
    {
        var response = await _client.PushNextAsync(CancellationToken.None).ConfigureAwait(false);
        if (!response.Success || response.Data is not { } data)
        {
            return response.ErrorCode switch
            {
                "NO_UPCOMING_RETURN" => "云端没有待发的返航通知，请先回到工坊让插件上报一次数据",
                "NOTIFICATIONS_DISABLED" => "已关闭返航通知，云端不会发送",
                "PROVIDER_NOT_CONFIGURED" => "云端尚未配置推送方式，请先保存推送设置",
                _ => "发送失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误"),
            };
        }

        var kind = data.Kind == "advance" ? "即将返航" : "返航";
        return $"已发送{kind}通知：{data.ShipCount} 艘，{TimeText.FormatLocal(data.ReturnAt)}（{data.Provider}，{data.LatencyMs} ms）";
    }

    // ---------------- 诊断 ----------------

    private void DrawDiagnosticsTab()
    {
        ImGui.Spacing();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "本地缓存");
        ImGui.TextWrapped(_cache.FilePath);

        var debug = _config.ShowDebugLog;
        if (ImGui.Checkbox("输出调试日志到 Dalamud 日志", ref debug))
        {
            _config.ShowDebugLog = debug;
            _config.Save();
        }

        var interval = _config.AutoScanIntervalSeconds;
        if (ImGui.InputInt("自动检查间隔（秒）", ref interval, 10, 60))
        {
            _config.AutoScanIntervalSeconds = Math.Clamp(interval, 10, 3600);
            _config.Save();
        }
        ImGui.TextDisabled("插件只在登录、切换区域、定时检查时读取数据，每次读取之间至少间隔 2 秒。");

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "最近错误（最多 20 条）");
        var errors = _cache.Document.Errors;
        if (errors.Count == 0)
        {
            ImGui.TextDisabled("没有记录");
        }
        else if (ImGui.BeginChild("##errors", new Vector2(-1, 200), true))
        {
            foreach (var entry in errors)
                ImGui.TextWrapped($"{entry.At.ToLocalTime():MM-dd HH:mm:ss} {entry.Message}");
            ImGui.EndChild();
        }

        if (ImGui.Button("清空错误记录"))
        {
            _cache.Document.Errors.Clear();
            _cache.Save();
        }
        ImGui.SameLine();
        if (ImGui.Button("重置本地缓存"))
        {
            lock (_cache.SyncRoot)
            {
                _cache.Document.Pending = null;
                _cache.Document.Errors.Clear();
                _cache.Save();
            }
            SetStatus("已重置本地缓存（不影响云端数据）", false);
        }

        ImGui.Separator();
        ImGui.TextColored(new Vector4(0.6f, 0.8f, 1f, 1f), "服务端状态");
        if (ImGui.Button("读取 /status")) RunAsync(FetchStatusAsync, s => s);

        DrawStatusLine();
    }

    private async Task<string> FetchStatusAsync()
    {
        var response = await _client.GetStatusAsync(CancellationToken.None).ConfigureAwait(false);
        if (!response.Success || response.Data is not { } data)
            return "读取失败：" + (response.ErrorMessage ?? response.ErrorCode ?? "未知错误");

        var subs = data.Submarines;
        var next = data.Scheduler?.NextAlarmAt;
        return $"云端潜水艇 {subs?.Total ?? 0} 艘（航行 {subs?.Sailing ?? 0} / 已返航 {subs?.Returned ?? 0} / 停泊 {subs?.Docked ?? 0}），" +
               $"待处理批次 {data.Scheduler?.PendingBatches ?? 0}，" +
               $"下次提醒 {(next is null ? "无" : TimeText.FormatLocal(next.Value))}";
    }

    // ---------------- 异步辅助 ----------------

    private void RunAsync(Func<Task<UploadResult>> action, Func<UploadResult, string> formatter)
        => RunAsync(async () => formatter(await action().ConfigureAwait(false)), s => s);

    private void RunAsync(Func<Task<string>> action, Func<string, string> formatter)
    {
        if (_busy) return;
        _busy = true;
        _ = Task.Run(async () =>
        {
            string message;
            var isError = false;
            try
            {
                message = formatter(await action().ConfigureAwait(false));
            }
            catch (OperationCanceledException)
            {
                message = "已取消";
                isError = true;
            }
            catch (Exception ex)
            {
                message = "操作失败：" + ex.Message;
                isError = true;
                _log.Error($"[SubmarineReturnNotifier] 界面操作异常: {ex.Message}");
            }
            finally
            {
                _busy = false;
            }

            SetStatus(message, isError);
        });
    }

    private void SetStatus(string message, bool isError)
    {
        _status = message;
        _statusIsError = isError;
        if (isError) _cache.AddError($"{DateTimeOffset.Now:HH:mm:ss} {message}");
    }

    private void DrawStatusLine()
    {
        if (_status.Length == 0) return;
        ImGui.Spacing();
        ImGui.TextColored(
            _statusIsError ? new Vector4(1f, 0.5f, 0.4f, 1f) : new Vector4(0.5f, 0.9f, 0.6f, 1f),
            _status);
    }
}
