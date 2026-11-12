using System.Text.Json;
using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>上传数据构造：槽位范围、排序与 wire 字段名必须与 Worker 的校验一致。</summary>
public class SyncPayloadTests
{
    [Fact]
    public void Payload_uses_camel_case_wire_names()
    {
        var request = SyncPayloadBuilder.Build(
            TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0)),
            TestData.T0);

        var json = JsonSerializer.Serialize(request);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal(TestData.CharacterId, root.GetProperty("characterId").GetString());
        Assert.Equal("测试角色", root.GetProperty("characterName").GetString());
        Assert.Equal(1000, root.GetProperty("worldId").GetInt32());
        Assert.Equal(TestData.T0, root.GetProperty("collectedAt").GetInt64());

        var sub = root.GetProperty("submarines")[0];
        Assert.Equal(0, sub.GetProperty("slotIndex").GetInt32());
        Assert.Equal("sailing", sub.GetProperty("state").GetString());
        Assert.Equal(TestData.T0 + 3600, sub.GetProperty("returnAt").GetInt64());
        Assert.Equal(1, sub.GetProperty("parts").GetProperty("hull").GetInt32());
    }

    [Fact]
    public void Submarines_are_sorted_by_slot()
    {
        var request = SyncPayloadBuilder.Build(
            TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(2), TestData.Sub(0), TestData.Sub(1)),
            TestData.T0);

        Assert.Equal(new[] { 0, 1, 2 }, request.Submarines.Select(s => s.SlotIndex));
    }

    [Fact]
    public void Slots_outside_zero_to_three_are_dropped()
    {
        var scan = TestData.Scan(TestData.CharacterId, TestData.T0, true,
            TestData.Sub(-1), TestData.Sub(0), TestData.Sub(3), TestData.Sub(4));

        var request = SyncPayloadBuilder.Build(scan, TestData.T0);

        Assert.Equal(new[] { 0, 3 }, request.Submarines.Select(s => s.SlotIndex));
    }

    [Fact]
    public void Empty_scan_produces_empty_submarine_list()
    {
        var request = SyncPayloadBuilder.Build(
            TestData.Scan(TestData.CharacterId, TestData.T0, true),
            TestData.T0);

        Assert.Empty(request.Submarines);
        Assert.Equal(TestData.CharacterId, request.CharacterId);
    }

    [Fact]
    public void Unknown_world_is_null()
    {
        var scan = new ScanResult
        {
            CharacterId = TestData.CharacterId,
            CharacterName = "测试角色",
            WorldId = null,
            CollectedAt = TestData.T0,
            Submarines = Array.Empty<SubmarineSnapshot>(),
            WorkshopLoaded = true,
        };

        Assert.Null(SyncPayloadBuilder.Build(scan, TestData.T0).WorldId);
    }

    [Fact]
    public void Hash_is_stable_regardless_of_input_order()
    {
        var a = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0), TestData.Sub(1));
        var b = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(1), TestData.Sub(0));

        var hashA = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(a, TestData.T0));
        var hashB = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(b, TestData.T0));

        Assert.Equal(hashA, hashB);
    }
}
