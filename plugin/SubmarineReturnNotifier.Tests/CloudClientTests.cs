using System.Net;
using System.Text;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Logging;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>HTTP 客户端：地址规范化、错误映射、token 不入日志。</summary>
public class CloudClientTests
{
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _respond;

        public StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => _respond = respond;

        public HttpRequestMessage? LastRequest { get; private set; }
        public int CallCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRequest = request;
            CallCount++;
            return Task.FromResult(_respond(request));
        }
    }

    private static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK)
        => new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static CloudClient Client(StubHandler handler, string url = "https://worker.test", string token = "srk_secret_token_123456")
        => new(new RecordingLog(), handler, url, token);

    [Theory]
    [InlineData("https://worker.test", "https://worker.test")]
    [InlineData("https://worker.test/", "https://worker.test")]
    [InlineData("  https://worker.test/api/  ", "https://worker.test/api")]
    [InlineData("worker.test", "https://worker.test")]
    [InlineData("", "")]
    public void Base_url_normalization(string input, string expected)
        => Assert.Equal(expected, CloudClient.NormalizeBase(input));

    [Theory]
    [InlineData("ftp://worker.test")]
    [InlineData("javascript:alert(1)")]
    public void Non_http_schemes_are_rejected(string input)
        => Assert.Equal(string.Empty, CloudClient.NormalizeBase(input));

    [Fact]
    public async Task Sync_sends_bearer_token_and_parses_envelope()
    {
        var handler = new StubHandler(_ => Json("""
            {"ok":true,"data":{"accepted":2,"changed":1,"removed":0,"deduped":false,"serverTime":1700000000,"nextSyncAfter":1700000060}}
            """));
        var client = Client(handler);

        var response = await client.SyncAsync(new SyncRequestDto { CharacterId = "abc" }, CancellationToken.None);

        Assert.True(response.Success);
        Assert.Equal(2, response.Data!.Accepted);
        Assert.Equal("Bearer", handler.LastRequest!.Headers.Authorization!.Scheme);
        Assert.Equal("srk_secret_token_123456", handler.LastRequest.Headers.Authorization.Parameter);
        Assert.EndsWith("/api/v1/submarines/sync", handler.LastRequest.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task Error_envelope_maps_to_code_and_message()
    {
        var handler = new StubHandler(_ => Json("""{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"bad slot"}}""", HttpStatusCode.BadRequest));
        var client = Client(handler);

        var response = await client.SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.False(response.Success);
        Assert.Equal("VALIDATION_ERROR", response.ErrorCode);
        Assert.Equal("bad slot", response.ErrorMessage);
        Assert.Equal(400, response.StatusCode);
        Assert.False(response.Unauthorized);
    }

    [Fact]
    public async Task Unauthorized_is_flagged()
    {
        var handler = new StubHandler(_ => Json("""{"ok":false,"error":{"code":"UNAUTHORIZED","message":"no"}}""", HttpStatusCode.Unauthorized));
        var response = await Client(handler).SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.True(response.Unauthorized);
    }

    [Fact]
    public async Task Non_json_error_page_does_not_throw()
    {
        var handler = new StubHandler(_ => new HttpResponseMessage(HttpStatusCode.BadGateway)
        {
            Content = new StringContent("<html>502</html>", Encoding.UTF8, "text/html"),
        });

        var response = await Client(handler).SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.False(response.Success);
        Assert.Equal("HTTP_ERROR", response.ErrorCode);
        Assert.Equal(502, response.StatusCode);
    }

    [Fact]
    public async Task Network_exception_becomes_network_error()
    {
        var handler = new StubHandler(_ => throw new HttpRequestException("no route"));
        var response = await Client(handler).SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.False(response.Success);
        Assert.Equal("NETWORK_ERROR", response.ErrorCode);
        Assert.Null(response.StatusCode);
    }

    [Fact]
    public async Task Missing_base_url_short_circuits()
    {
        var handler = new StubHandler(_ => Json("{}"));
        var response = await Client(handler, url: "").SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.Equal("NOT_CONFIGURED", response.ErrorCode);
        Assert.Equal(0, handler.CallCount);
    }

    [Fact]
    public async Task Missing_token_short_circuits_authenticated_calls()
    {
        var handler = new StubHandler(_ => Json("{}"));
        var client = Client(handler, token: "");

        var response = await client.SyncAsync(new SyncRequestDto(), CancellationToken.None);
        Assert.Equal("NOT_AUTHENTICATED", response.ErrorCode);
        Assert.Equal(0, handler.CallCount);

        // 注册与健康检查不需要 token
        handler = new StubHandler(_ => Json("""{"ok":true,"data":{"status":"ok","serverTime":1}}"""));
        var health = await Client(handler, token: "").HealthAsync(CancellationToken.None);
        Assert.True(health.Success);
    }

    [Fact]
    public async Task Token_never_appears_in_logs()
    {
        var log = new RecordingLog();
        var handler = new StubHandler(_ => throw new HttpRequestException("boom"));
        var client = new CloudClient(log, handler, "https://worker.test", "srk_super_secret_value");

        await client.SyncAsync(new SyncRequestDto(), CancellationToken.None);

        Assert.DoesNotContain(log.Messages, m => m.Contains("srk_super_secret_value", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Test_push_sends_draft_credentials()
    {
        var handler = new StubHandler(_ => Json("""{"ok":true,"data":{"delivered":true,"provider":"bark","latencyMs":120}}"""));
        var client = Client(handler);

        var response = await client.TestPushAsync(
            new TestPushRequestDto { Provider = "bark", DeviceKey = "draft-key", ServerUrl = "https://api.day.app" },
            CancellationToken.None);

        Assert.True(response.Success);
        Assert.Equal(120, response.Data!.LatencyMs);
        Assert.EndsWith("/api/v1/push/test", handler.LastRequest!.RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task Push_next_posts_without_body_and_parses_batch_info()
    {
        var handler = new StubHandler(_ => Json("""
            {"ok":true,"data":{"delivered":true,"provider":"bark","latencyMs":88,"kind":"advance",
             "notifyAt":1700000600,"returnAt":1700000900,"shipCount":3,"title":"潜水艇返航（即将返航）"}}
            """));
        var client = Client(handler);

        var response = await client.PushNextAsync(CancellationToken.None);

        Assert.True(response.Success);
        Assert.Equal("advance", response.Data!.Kind);
        Assert.Equal(3, response.Data.ShipCount);
        Assert.Equal(1700000900, response.Data.ReturnAt);
        Assert.Equal("潜水艇返航（即将返航）", response.Data.Title);
        Assert.Equal(HttpMethod.Post, handler.LastRequest!.Method);
        Assert.EndsWith("/api/v1/push/next", handler.LastRequest.RequestUri!.AbsolutePath);
        Assert.Null(handler.LastRequest.Content);
    }

    [Fact]
    public async Task Push_next_maps_no_upcoming_return_to_error_code()
    {
        var handler = new StubHandler(_ => Json("""{"ok":false,"error":{"code":"NO_UPCOMING_RETURN","message":"none"}}""", HttpStatusCode.Conflict));
        var client = Client(handler);

        var response = await client.PushNextAsync(CancellationToken.None);

        Assert.False(response.Success);
        Assert.Equal("NO_UPCOMING_RETURN", response.ErrorCode);
        Assert.Equal(409, response.StatusCode);
    }

    [Fact]
    public async Task Create_device_uses_override_token_without_changing_config()
    {
        var handler = new StubHandler(_ => Json("""
            {"ok":true,"data":{"deviceId":"dev_new","token":"srk_new_device_token","tokenPrefix":"srk_newd","serverTime":1700000000}}
            """, HttpStatusCode.Created));
        var client = Client(handler);

        var response = await client.CreateDeviceAsync("笔记本", CancellationToken.None, "srk_other_device_token");

        Assert.True(response.Success);
        Assert.Equal("dev_new", response.Data!.DeviceId);
        Assert.Equal("srk_new_device_token", response.Data.Token);
        // 用粘贴来的 token 认证，而不是本机已配置的那个
        Assert.Equal("srk_other_device_token", handler.LastRequest!.Headers.Authorization!.Parameter);
        Assert.EndsWith("/api/v1/auth/device", handler.LastRequest.RequestUri!.AbsolutePath);
        // 配置里的 token 不变，绑定成功后才由调用方写入
        Assert.Equal("srk_secret_token_123456", client.Token);
    }

    [Fact]
    public async Task Whoami_with_override_token_does_not_leak_it_into_errors()
    {
        var log = new RecordingLog();
        var handler = new StubHandler(_ => Json("""{"ok":false,"error":{"code":"INVALID_TOKEN","message":"Authentication failed"}}""", HttpStatusCode.Unauthorized));
        var client = new CloudClient(log, handler, "https://worker.test", "srk_configured");

        var response = await client.WhoAmIAsync(CancellationToken.None, "srk_wrong_token");

        Assert.False(response.Success);
        Assert.Equal("INVALID_TOKEN", response.ErrorCode);
        Assert.Equal("srk_wrong_token", handler.LastRequest!.Headers.Authorization!.Parameter);
        Assert.DoesNotContain(log.Messages, m => m.Contains("srk_wrong_token", StringComparison.Ordinal));
    }
}
