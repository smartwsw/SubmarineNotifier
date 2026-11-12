using System.Text.Json;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Storage;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>本地缓存恢复（对应 TODO §11 "本地缓存恢复""插件重新加载"）。</summary>
public sealed class LocalCacheTests : IDisposable
{
    private readonly string _dir;

    public LocalCacheTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "subnotify-tests", Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { }
    }

    private static CacheDocument SampleDocument()
    {
        var scan = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0), TestData.Sub(1));
        var pending = PendingUpload.FromScan(scan);
        pending.Attempts = 3;
        pending.LastError = "网络错误";
        pending.NextAttemptAt = DateTimeOffset.UnixEpoch.AddSeconds(TestData.T0 + 120);
        pending.LastSuccessAt = DateTimeOffset.UnixEpoch.AddSeconds(TestData.T0 - 600);
        pending.LastPayloadHash = "hash-1";

        return new CacheDocument
        {
            ApiBaseUrl = "https://example.workers.dev",
            UserId = "user-1",
            DeviceId = "device-1",
            TokenPrefix = "srk_abcd1234",
            Pending = pending,
            LastScan = PendingUpload.FromScan(scan),
        };
    }

    [Fact]
    public void Missing_file_returns_empty_document()
    {
        var store = new LocalCacheStore(_dir);
        var doc = store.Load();

        Assert.Null(doc.Pending);
        Assert.Empty(doc.Errors);
        Assert.Equal(1, doc.Version);
    }

    [Fact]
    public void Roundtrip_preserves_state()
    {
        var store = new LocalCacheStore(_dir);
        store.Save(SampleDocument());

        var loaded = store.Load();

        Assert.Equal("https://example.workers.dev", loaded.ApiBaseUrl);
        Assert.Equal("user-1", loaded.UserId);
        Assert.Equal("device-1", loaded.DeviceId);
        Assert.Equal("srk_abcd1234", loaded.TokenPrefix);
        Assert.NotNull(loaded.Pending);
        Assert.Equal(3, loaded.Pending!.Attempts);
        Assert.Equal("网络错误", loaded.Pending.LastError);
        Assert.Equal("hash-1", loaded.Pending.LastPayloadHash);
        Assert.Equal(2, loaded.Pending.Submarines.Count);
        Assert.NotNull(loaded.LastScan);
    }

    [Fact]
    public void Atomic_save_leaves_no_temp_file()
    {
        var store = new LocalCacheStore(_dir);
        store.Save(SampleDocument());
        store.Save(SampleDocument());

        Assert.False(File.Exists(store.FilePath + ".tmp"));
        Assert.True(File.Exists(store.FilePath));
    }

    [Fact]
    public void Corrupted_file_falls_back_to_empty_document()
    {
        var store = new LocalCacheStore(_dir);
        File.WriteAllText(store.FilePath, "{ this is not json");

        var doc = store.Load();

        Assert.Null(doc.Pending);
        Assert.Equal(1, doc.Version);
    }

    [Fact]
    public void Unsupported_version_is_discarded()
    {
        var store = new LocalCacheStore(_dir);
        File.WriteAllText(store.FilePath, JsonSerializer.Serialize(new { version = 99, pending = "x" }));

        var doc = store.Load();

        Assert.Null(doc.Pending);
        Assert.Equal(1, doc.Version);
    }

    [Fact]
    public void Errors_are_persisted()
    {
        var store = new LocalCacheStore(_dir);
        var doc = SampleDocument();
        doc.Errors.Add(new ErrorLogEntry { At = DateTimeOffset.UnixEpoch, Message = "第一条错误" });
        store.Save(doc);

        var loaded = store.Load();

        Assert.Single(loaded.Errors);
        Assert.Equal("第一条错误", loaded.Errors[0].Message);
    }

    /// <summary>模拟"插件重新加载"：新实例必须能从同一目录恢复出待上传数据。</summary>
    [Fact]
    public void Pending_data_survives_reload()
    {
        new LocalCacheStore(_dir).Save(SampleDocument());

        var reloaded = new LocalCacheStore(_dir).Load();

        Assert.NotNull(reloaded.Pending);
        Assert.True(reloaded.Pending!.HasPending);
        Assert.Equal(TestData.CharacterId, reloaded.Pending.CharacterId);

        var request = reloaded.Pending.ToRequest(TestData.T0);
        Assert.Equal(TestData.CharacterId, request.CharacterId);
        Assert.Equal(2, request.Submarines.Count);
        Assert.Equal("sailing", request.Submarines[0].State);
    }

    /// <summary>角色切换后 pending 必须被新角色的数据替换，不能混用。</summary>
    [Fact]
    public void Pending_from_other_character_is_replaced_by_new_scan()
    {
        var store = new LocalCacheStore(_dir);
        var doc = SampleDocument();
        store.Save(doc);

        var reloaded = store.Load();
        var otherCharacter = TestData.Scan("character-other", TestData.T0 + 60, true, TestData.Sub(2));
        reloaded.Pending = PendingUpload.FromScan(otherCharacter);
        store.Save(reloaded);

        var again = store.Load();
        Assert.Equal("character-other", again.Pending!.CharacterId);
        Assert.Single(again.Pending.Submarines);
        Assert.Equal(2, again.Pending.Submarines[0].SlotIndex);
    }
}
