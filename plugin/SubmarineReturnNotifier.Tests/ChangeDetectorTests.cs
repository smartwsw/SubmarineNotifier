using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Submarine;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>返航时间变化检测与重复数据过滤（对应 TODO §11 "返航时间变化检测""重复数据过滤"）。</summary>
public class ChangeDetectorTests
{
    [Fact]
    public void First_scan_counts_as_added()
    {
        var summary = ChangeDetector.Compare(null, TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0)));

        Assert.Equal(ChangeKind.Added, summary.Kind);
        Assert.True(summary.HasChanges);
    }

    [Fact]
    public void Identical_scans_produce_no_changes()
    {
        var scan = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0));
        var same = TestData.Scan(TestData.CharacterId, TestData.T0 + 300, true, TestData.Sub(0));

        var summary = ChangeDetector.Compare(scan, same);

        Assert.Equal(ChangeKind.None, summary.Kind);
        Assert.False(summary.HasChanges);
        Assert.Empty(summary.Details);
    }

    [Fact]
    public void Return_time_change_is_detected()
    {
        var before = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0, returnAt: TestData.T0 + 3600));
        var after = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true, TestData.Sub(0, returnAt: TestData.T0 + 7200));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.ReturnTimeChanged, summary.Kind);
        Assert.Contains(summary.Details, d => d.Contains("返航时间"));
    }

    [Fact]
    public void State_change_alone_is_detected()
    {
        var before = TestData.Scan(TestData.CharacterId, TestData.T0, true,
            TestData.Sub(0, state: SubmarineState.Sailing));
        var after = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true,
            TestData.Sub(0, state: SubmarineState.Returned));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.StateChanged, summary.Kind);
    }

    [Fact]
    public void New_submarine_in_slot_is_detected()
    {
        var before = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0));
        var after = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true, TestData.Sub(0), TestData.Sub(1));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.Added, summary.Kind);
        Assert.Contains(summary.Details, d => d.Contains("槽位 1 新增"));
    }

    [Fact]
    public void Removed_submarine_is_detected()
    {
        var before = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0), TestData.Sub(1));
        var after = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true, TestData.Sub(0));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.Removed, summary.Kind);
        Assert.Contains(summary.Details, d => d.Contains("槽位 1 消失"));
    }

    [Fact]
    public void Character_switch_is_detected()
    {
        var before = TestData.Scan("character-a", TestData.T0, true, TestData.Sub(0));
        var after = TestData.Scan("character-b", TestData.T0 + 60, true, TestData.Sub(0));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.CharacterChanged, summary.Kind);
    }

    [Fact]
    public void Part_change_is_detected_as_detail_change()
    {
        var before = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0, hull: 1));
        var after = TestData.Scan(TestData.CharacterId, TestData.T0 + 60, true, TestData.Sub(0, hull: 9));

        var summary = ChangeDetector.Compare(before, after);

        Assert.Equal(ChangeKind.DetailsChanged, summary.Kind);
    }

    [Fact]
    public void Fingerprint_is_stable_for_equal_content()
    {
        Assert.Equal(TestData.Sub(0).Fingerprint, TestData.Sub(0).Fingerprint);
        Assert.NotEqual(TestData.Sub(0).Fingerprint, TestData.Sub(0, hull: 7).Fingerprint);
    }

    // ---------------- 重复数据过滤 ----------------

    [Fact]
    public void Payload_hash_ignores_collection_time()
    {
        var scanA = TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0));
        var scanB = TestData.Scan(TestData.CharacterId, TestData.T0 + 600, true, TestData.Sub(0));

        var hashA = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(scanA, TestData.T0));
        var hashB = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(scanB, TestData.T0 + 600));

        Assert.Equal(hashA, hashB);
    }

    [Fact]
    public void Payload_hash_changes_when_return_time_changes()
    {
        var hashA = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(
            TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0, returnAt: TestData.T0 + 3600)), TestData.T0));
        var hashB = Hashing.HashSyncRequest(SyncPayloadBuilder.Build(
            TestData.Scan(TestData.CharacterId, TestData.T0, true, TestData.Sub(0, returnAt: TestData.T0 + 7200)), TestData.T0));

        Assert.NotEqual(hashA, hashB);
    }
}
