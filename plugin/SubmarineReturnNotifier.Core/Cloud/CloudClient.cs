using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using SubmarineReturnNotifier.Core.Logging;

namespace SubmarineReturnNotifier.Core.Cloud;

/// <summary>
/// Cloudflare Worker 客户端。所有方法都不抛异常（网络/序列化错误转换为 <c>CloudResponse</c>），
/// 以免任何云端问题影响到游戏主线程。
/// </summary>
public sealed class CloudClient : ICloudApi, IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _http;
    private readonly ILogSink _log;

    public CloudClient(ILogSink log)
        : this(log, new HttpClientHandler(), string.Empty, string.Empty)
    {
    }

    /// <summary>供测试注入 <see cref="HttpMessageHandler"/> 与初始配置。</summary>
    public CloudClient(ILogSink log, HttpMessageHandler handler, string baseUrl, string token)
    {
        _log = log;
        _http = new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(15) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("SubmarineReturnNotifier/1.0 (+Dalamud)");
        Configure(baseUrl, token);
    }

    public string BaseUrl { get; private set; } = string.Empty;
    public string Token { get; private set; } = string.Empty;

    public void Configure(string baseUrl, string token)
    {
        BaseUrl = NormalizeBase(baseUrl);
        Token = token ?? string.Empty;
    }

    /// <summary>
    /// 规范化用户输入的地址：
    ///  - 只接受 http/https；
    ///  - 去掉末尾斜杠；
    ///  - 用户只填主机名时补 https。
    /// </summary>
    public static string NormalizeBase(string baseUrl)
    {
        var trimmed = (baseUrl ?? string.Empty).Trim();
        if (trimmed.Length == 0) return string.Empty;
        if (!trimmed.Contains("://", StringComparison.Ordinal)) trimmed = "https://" + trimmed;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)) return string.Empty;
        if (uri.Scheme is not ("http" or "https")) return string.Empty;
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    public async Task<CloudResponse<SyncResponseDto>> SyncAsync(SyncRequestDto payload, CancellationToken cancellationToken)
        => await PostAsync<SyncResponseDto>("/api/v1/submarines/sync", payload, cancellationToken).ConfigureAwait(false);

    public async Task<CloudResponse<RegisterResponseDto>> RegisterAsync(string deviceName, CancellationToken cancellationToken)
        => await PostAsync<RegisterResponseDto>("/api/v1/auth/register", new { deviceName }, cancellationToken, authenticated: false)
            .ConfigureAwait(false);

    /// <summary>
    /// 在已有账号下签发一个新设备（同一用户的多台电脑共用潜水艇与推送设置）。
    /// 需要先用该账号任一设备的 token 认证。
    /// </summary>
    public async Task<CloudResponse<DeviceRegistrationDto>> CreateDeviceAsync(
        string deviceName,
        CancellationToken cancellationToken,
        string? tokenOverride = null)
        => await SendAsync<DeviceRegistrationDto>(
                HttpMethod.Post, "/api/v1/auth/device", new { deviceName }, cancellationToken, tokenOverride: tokenOverride)
            .ConfigureAwait(false);

    /// <summary>测试连接（无需认证）：/health 不校验 token，用来区分"地址错误"和"token 错误"。</summary>
    public async Task<CloudResponse<HealthDto>> HealthAsync(CancellationToken cancellationToken)
        => await GetAsync<HealthDto>("/api/v1/health", cancellationToken, authenticated: false).ConfigureAwait(false);

    public async Task<CloudResponse<StatusResponseDto>> GetStatusAsync(CancellationToken cancellationToken)
        => await GetAsync<StatusResponseDto>("/api/v1/status", cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// 查询当前 token 对应的账号。
    /// `tokenOverride` 用于"加入已有账号"：拿用户粘贴的 token 认证，而不改动当前配置。
    /// </summary>
    public async Task<CloudResponse<WhoAmIDto>> WhoAmIAsync(CancellationToken cancellationToken, string? tokenOverride = null)
        => await SendAsync<WhoAmIDto>(HttpMethod.Get, "/api/v1/auth/whoami", null, cancellationToken, tokenOverride: tokenOverride)
            .ConfigureAwait(false);

    public async Task<CloudResponse<SettingsDto>> GetSettingsAsync(CancellationToken cancellationToken)
        => await GetAsync<SettingsDto>("/api/v1/settings", cancellationToken).ConfigureAwait(false);

    public async Task<CloudResponse<SettingsDto>> PutSettingsAsync(SettingsPatchDto patch, CancellationToken cancellationToken)
        => await SendAsync<SettingsDto>(HttpMethod.Put, "/api/v1/settings", patch, cancellationToken).ConfigureAwait(false);

    /// <summary>测试推送。serviceKey 可以是尚未保存的草稿值（云端会用请求体覆盖）。</summary>
    public async Task<CloudResponse<TestPushResultDto>> TestPushAsync(TestPushRequestDto request, CancellationToken cancellationToken)
        => await PostAsync<TestPushResultDto>("/api/v1/push/test", request, cancellationToken).ConfigureAwait(false);

    /// <summary>
    /// 让云端立即推送「下一次返航」的通知。
    /// 只读云端已排定的批次内容，不改排程，正式通知仍会按原计划再发一次。
    /// </summary>
    public async Task<CloudResponse<NextPushResultDto>> PushNextAsync(CancellationToken cancellationToken)
        => await PostAsync<NextPushResultDto>("/api/v1/push/next", null, cancellationToken).ConfigureAwait(false);

    /// <summary>删除账号（云端会同时清理该用户的 Durable Object 状态）。</summary>
    public async Task<CloudResponse<object>> DeleteAccountAsync(CancellationToken cancellationToken)
        => await SendAsync<object>(HttpMethod.Delete, "/api/v1/account", new { confirm = "DELETE" }, cancellationToken)
            .ConfigureAwait(false);

    private async Task<CloudResponse<T>> GetAsync<T>(string path, CancellationToken cancellationToken, bool authenticated = true)
        => await SendAsync<T>(HttpMethod.Get, path, null, cancellationToken, authenticated).ConfigureAwait(false);

    private async Task<CloudResponse<T>> PostAsync<T>(string path, object? body, CancellationToken cancellationToken, bool authenticated = true)
        => await SendAsync<T>(HttpMethod.Post, path, body, cancellationToken, authenticated).ConfigureAwait(false);

    private async Task<CloudResponse<T>> SendAsync<T>(
        HttpMethod method,
        string path,
        object? body,
        CancellationToken cancellationToken,
        bool authenticated = true,
        string? tokenOverride = null)
    {
        if (BaseUrl.Length == 0)
            return new CloudResponse<T>(false, default, "NOT_CONFIGURED", "未设置 API 地址", null);

        var token = tokenOverride?.Trim() is { Length: > 0 } provided ? provided : Token;
        if (authenticated && token.Length == 0)
            return new CloudResponse<T>(false, default, "NOT_AUTHENTICATED", "尚未绑定设备", null);

        try
        {
            using var request = new HttpRequestMessage(method, BaseUrl + path);
            if (authenticated) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            if (body is not null) request.Content = JsonContent.Create(body, options: JsonOptions);

            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken)
                .ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

            if (!response.IsSuccessStatusCode)
            {
                var parsed = TryParseError(text);
                _log.Warn($"[SubmarineReturnNotifier] {method} {path} -> {(int)response.StatusCode} {parsed.code}");
                return new CloudResponse<T>(false, default, parsed.code, parsed.message, (int)response.StatusCode);
            }

            if (typeof(T) == typeof(object) || string.IsNullOrWhiteSpace(text))
            {
                return new CloudResponse<T>(true, default, null, null, (int)response.StatusCode);
            }

            var envelope = JsonSerializer.Deserialize<ApiEnvelope<T>>(text, JsonOptions);
            if (envelope is null)
                return new CloudResponse<T>(false, default, "INVALID_RESPONSE", "响应不是有效 JSON", (int)response.StatusCode);

            if (!envelope.Ok)
                return new CloudResponse<T>(false, default, envelope.Error?.Code, envelope.Error?.Message, (int)response.StatusCode);

            return new CloudResponse<T>(true, envelope.Data, null, null, (int)response.StatusCode);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return new CloudResponse<T>(false, default, "CANCELLED", "请求已取消", null);
        }
        catch (TaskCanceledException)
        {
            return new CloudResponse<T>(false, default, "TIMEOUT", "请求超时", null);
        }
        catch (HttpRequestException ex)
        {
            _log.Warn($"[SubmarineReturnNotifier] 网络错误: {ex.Message}");
            return new CloudResponse<T>(false, default, "NETWORK_ERROR", ex.Message, null);
        }
        catch (JsonException ex)
        {
            _log.Warn($"[SubmarineReturnNotifier] 响应解析失败: {ex.Message}");
            return new CloudResponse<T>(false, default, "INVALID_RESPONSE", "无法解析云端响应", null);
        }
    }

    private static (string code, string message) TryParseError(string text)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<ApiEnvelope<object>>(text, JsonOptions);
            if (envelope?.Error is { } error) return (error.Code, error.Message);
        }
        catch (JsonException)
        {
            // 非 JSON 错误页（如 Cloudflare 502）
        }
        return ("HTTP_ERROR", string.IsNullOrWhiteSpace(text) ? "云端返回错误" : text[..Math.Min(text.Length, 200)]);
    }

    public void Dispose() => _http.Dispose();
}
