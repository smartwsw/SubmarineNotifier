using System.Diagnostics;
using System.Text;
using System.Text.Json;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Logging;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Notification;
using SubmarineReturnNotifier.Core.Storage;

// 插件 ↔ Worker 联调：用真实的 Core 代码对本地 wrangler dev 执行完整流程。
// 这不是单元测试，而是端到端验证（Phase 5）。

// 模式一（默认）：对本地 Worker 跑完整流程。
// 模式二：verify-notification <artifact.json>，把云端真实发出的文案与插件预览逐字比对。

var failures = 0;

void Check(string name, bool condition, string? detail = null)
{
    Console.WriteLine($"{(condition ? "PASS" : "FAIL")}  {name}{(detail is null ? "" : "  — " + detail)}");
    if (!condition) failures++;
}

if (args.Length >= 2 && args[0] == "verify-notification")
{
    var doc = JsonSerializer.Deserialize<CloudArtifact>(File.ReadAllText(args[1]),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
    if (doc is null)
    {
        Console.WriteLine("FAIL  无法读取云端通知产物");
        return 1;
    }

    var returnedLines = doc.Returned.Lines
        .Select(l => new NotificationPreview.NoticeLine(l.Name, l.ReturnAt))
        .ToList();
    var advanceLines = doc.AdvanceLines
        .Select(l => new NotificationPreview.NoticeLine(l.Name, l.ReturnAt))
        .ToList();

    var returned = NotificationPreview.Format(doc.TitleTemplate, doc.BodyTemplate, returnedLines, advance: false, doc.Timezone);
    var advance = NotificationPreview.Format(doc.TitleTemplate, doc.BodyTemplate, advanceLines, advance: true, doc.Timezone);

    Check("正式通知标题与云端一致", returned.Title == doc.Returned.Title, $"cloud={doc.Returned.Title} plugin={returned.Title}");
    Check("正式通知正文与云端逐字一致", returned.Body == doc.Returned.Body, $"\ncloud={doc.Returned.Body}\nplugin={returned.Body}");
    Check("提前通知标题与云端一致", advance.Title == doc.Advance.Title, $"cloud={doc.Advance.Title} plugin={advance.Title}");
    Check("提前通知正文与云端逐字一致", advance.Body == doc.Advance.Body, $"\ncloud={doc.Advance.Body}\nplugin={advance.Body}");

    Console.WriteLine();
    Console.WriteLine(failures == 0 ? "插件预览与云端推送文案一致" : $"不一致 {failures} 项");
    return failures == 0 ? 0 : 1;
}

var baseUrl = args.Length > 0 ? args[0] : "http://127.0.0.1:8787";

Console.WriteLine($"BaseUrl = {CloudClient.NormalizeBase(baseUrl)}");

var log = new ConsoleLog();
var client = new CloudClient(log, new HttpClientHandler(), baseUrl, string.Empty);

// ---------- 1. 健康检查 ----------
var health = await client.HealthAsync(CancellationToken.None);
Check("健康检查", health.Success && health.Data?.Status == "ok", health.ErrorMessage);

// ---------- 2. 注册 ----------
var register = await client.RegisterAsync("联调设备", CancellationToken.None);
Check("注册返回 token", register.Success && register.Data is { } && register.Data.Token.StartsWith("srk_"),
    register.Success ? $"prefix={register.Data!.TokenPrefix}" : register.ErrorMessage);
if (!register.Success || register.Data is null) return 1;

var token = register.Data.Token;
var userId = register.Data.UserId;
Check("token 完整长度 >= 40", token.Length >= 40, $"{token.Length} chars");
client.Configure(baseUrl, token);

// ---------- 3. whoami ----------
var who = await client.WhoAmIAsync(CancellationToken.None);
Check("whoami 返回同一用户", who.Success && who.Data?.UserId == userId);

// ---------- 4. 无 token 时被拒绝 ----------
var anonymous = new CloudClient(log, new HttpClientHandler(), baseUrl, string.Empty);
var denied = await anonymous.SyncAsync(new SyncRequestDto(), CancellationToken.None);
Check("无 token 上传被拒绝", !denied.Success && denied.ErrorCode == "NOT_AUTHENTICATED", denied.ErrorCode);

var badToken = new CloudClient(log, new HttpClientHandler(), baseUrl, "srk_invalid_token_value_0000000000");
var unauthorized = await badToken.GetStatusAsync(CancellationToken.None);
Check("无效 token 返回 401", unauthorized.StatusCode == 401, unauthorized.ErrorCode);

// ---------- 5. 同步 ----------
var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
var returnAt = now + 3600;

var scan = new ScanResult
{
    CharacterId = "18014400000000001",
    CharacterName = "联调角色",
    WorldId = 1001,
    CollectedAt = now,
    WorkshopLoaded = true,
    Submarines = new[]
    {
        new SubmarineSnapshot
        {
            SlotIndex = 0, Name = "鲨鱼一号", Rank = 30, ReturnAt = returnAt,
            State = SubmarineState.Sailing, RoutePoints = new[] { 1, 2, 3 },
            Parts = new Dictionary<string, int> { ["hull"] = 1, ["stern"] = 2, ["bow"] = 3, ["bridge"] = 4 },
        },
        new SubmarineSnapshot
        {
            SlotIndex = 1, Name = "鲨鱼二号", Rank = 20, ReturnAt = returnAt + 300,
            State = SubmarineState.Sailing, RoutePoints = new[] { 4, 5 },
            Parts = new Dictionary<string, int> { ["hull"] = 5, ["stern"] = 6, ["bow"] = 7, ["bridge"] = 8 },
        },
    },
};

var cacheDir = Path.Combine(Path.GetTempPath(), "subnotify-integration", Guid.NewGuid().ToString("n"));
var uploader = new CloudUploader(client, new LocalCacheFacade(cacheDir), log);
var payload = SyncPayloadBuilder.Build(scan, now);
var hash = Hashing.HashSyncRequest(payload);
Check("首次扫描产生待上传", uploader.RecordScan(scan, hash));

var first = await uploader.TryUploadAsync(force: false, CancellationToken.None);
Check("首次上传成功", first.Outcome == UploadOutcome.Success, first.Message);

// ---------- 6. 重复上传被去重 ----------
var second = await uploader.TryUploadAsync(force: true, CancellationToken.None);
Check("重复上传被云端去重", second.Outcome == UploadOutcome.Deduped, second.Message);

// ---------- 7. 内容未变化时不重复上传 ----------
var rescan = scan with { CollectedAt = now + 60 };
var changed = uploader.RecordScan(rescan, Hashing.HashSyncRequest(SyncPayloadBuilder.Build(rescan, now + 60)));
Check("相同内容不产生待上传变化", !changed);
var third = await uploader.TryUploadAsync(force: false, CancellationToken.None);
Check("相同内容不上传", third.Outcome == UploadOutcome.NoChanges, third.Message);

// ---------- 8. 返航时间变化后重新上传 ----------
var moved = scan with
{
    CollectedAt = now + 120,
    Submarines = new[]
    {
        scan.Submarines[0] with { ReturnAt = returnAt + 600 },
        scan.Submarines[1],
    },
};
var movedHash = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(moved, now + 120));
Check("返航时间变化产生待上传", uploader.RecordScan(moved, movedHash));
var fourth = await uploader.TryUploadAsync(force: false, CancellationToken.None);
Check("返航时间变化后上传成功", fourth.IsSuccess, fourth.Message);

// ---------- 9. 状态与排程 ----------
var status = await client.GetStatusAsync(CancellationToken.None);
Check("status 返回潜水艇计数", status.Success && status.Data?.Submarines?.Total == 2,
    $"total={status.Data?.Submarines?.Total}");
var nextAlarm = status.Data?.Scheduler?.NextAlarmAt;
Check("云端已排程下次提醒", nextAlarm is not null && nextAlarm > now,
    nextAlarm is null ? "none" : $"in {nextAlarm - now}s");
Check("待处理批次存在", (status.Data?.Scheduler?.PendingBatches ?? 0) >= 1,
    $"batches={status.Data?.Scheduler?.PendingBatches}");

// ---------- 10. 合并窗口 ----------
var settings = await client.PutSettingsAsync(new SettingsPatchDto
{
    MergeWindowMinutes = 10,
    AdvanceNotificationMinutes = 5,
    NotificationEnabled = true,
    Provider = "bark",
    ProviderServerUrl = "https://api.day.app",
    ProviderToken = "integration-test-device-key",
    NotifyTitle = "联调通知",
}, CancellationToken.None);
Check("推送设置已保存", settings.Success, settings.ErrorMessage);
Check("凭据只返回掩码", settings.Success && settings.Data?.ProviderTokenMasked == "••••••••" &&
    !JsonSerializer.Serialize(settings.Data).Contains("integration-test-device-key", StringComparison.Ordinal));
Check("Bark Key 不回传", settings.Success && string.IsNullOrEmpty(settings.Data?.ProviderTokenMasked) == false);

// ---------- 11. 测试推送（本地无外网，预期失败但不 500） ----------
var test = await client.TestPushAsync(new TestPushRequestDto { Provider = "bark" }, CancellationToken.None);
Check("测试推送返回受控错误", !test.Success && test.StatusCode is 502 or 400,
    $"status={test.StatusCode} code={test.ErrorCode}");

// ---------- 12. 设置读回 ----------
var readBack = await client.GetSettingsAsync(CancellationToken.None);
Check("读回设置包含合并窗口", readBack.Success && readBack.Data?.MergeWindowMinutes == 10);

// ---------- 13. 删除账号 ----------
var deleted = await client.DeleteAccountAsync(CancellationToken.None);
Check("删除账号成功", deleted.Success, deleted.ErrorMessage);
var afterDelete = await client.GetStatusAsync(CancellationToken.None);
Check("删除后 token 失效", afterDelete.StatusCode == 401, afterDelete.ErrorCode);

// ---------- 14. 日志中不出现 token ----------
Check("日志不含完整 token", !log.Messages.Any(m => m.Contains(token, StringComparison.Ordinal)),
    $"记录 {log.Messages.Count} 条日志");

Console.WriteLine();
Console.WriteLine(failures == 0 ? "联调全部通过" : $"联调失败 {failures} 项");
return failures == 0 ? 0 : 1;

internal sealed class CloudArtifact
{
    public string Timezone { get; set; } = "UTC";
    public string TitleTemplate { get; set; } = string.Empty;
    public string BodyTemplate { get; set; } = string.Empty;
    public PushText Advance { get; set; } = new();
    public PushText Returned { get; set; } = new();
    public List<Line> AdvanceLines { get; set; } = new();
}

internal sealed class PushText
{
    public string Title { get; set; } = string.Empty;
    public string Body { get; set; } = string.Empty;
    public List<Line> Lines { get; set; } = new();
}

internal sealed class Line
{
    public string Name { get; set; } = string.Empty;
    public long ReturnAt { get; set; }
}

internal sealed class ConsoleLog : ILogSink
{
    public List<string> Messages { get; } = new();
    public void Info(string message) => Record("INFO", message);
    public void Warn(string message) => Record("WARN", message);
    public void Error(string message) => Record("ERROR", message);
    public void Debug(string message) => Record("DBG ", message);

    private void Record(string level, string message)
    {
        Messages.Add(message);
        Console.WriteLine($"      [{level}] {message}");
    }
}
