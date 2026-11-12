using SubmarineReturnNotifier.Core.Cloud;
using SubmarineReturnNotifier.Core.Models;
using SubmarineReturnNotifier.Core.Submarine;
using Xunit;

namespace SubmarineReturnNotifier.Tests;

/// <summary>状态识别与返航时间校验（对应 TODO §11 "状态识别"）。</summary>
public class SubmarineStateTests
{
    [Fact]
    public void ReturnAt_zero_is_docked()
        => Assert.Equal(SubmarineState.Docked, ReturnTimeCalculator.DeriveState(0, TestData.T0));

    [Fact]
    public void Future_return_time_is_sailing()
        => Assert.Equal(SubmarineState.Sailing, ReturnTimeCalculator.DeriveState(TestData.T0 + 1, TestData.T0));

    [Fact]
    public void Return_time_equal_to_now_is_returned()
        => Assert.Equal(SubmarineState.Returned, ReturnTimeCalculator.DeriveState(TestData.T0, TestData.T0));

    [Fact]
    public void Past_return_time_is_returned()
        => Assert.Equal(SubmarineState.Returned, ReturnTimeCalculator.DeriveState(TestData.T0 - 60, TestData.T0));

    [Theory]
    [InlineData(0)]
    [InlineData(TestData.T0 + 3600)]
    public void Plausible_return_times_are_accepted(long returnAt)
        => Assert.True(ReturnTimeCalculator.IsPlausibleReturnTime(returnAt, TestData.T0));

    [Fact]
    public void Absurdly_far_future_is_rejected()
        => Assert.False(ReturnTimeCalculator.IsPlausibleReturnTime(
            TestData.T0 + ReturnTimeCalculator.MaxVoyageSeconds + 1, TestData.T0));

    [Fact]
    public void Absurdly_far_past_is_rejected()
        => Assert.False(ReturnTimeCalculator.IsPlausibleReturnTime(
            TestData.T0 - ReturnTimeCalculator.MaxPastOffsetSeconds - 1, TestData.T0));

    [Fact]
    public void Remaining_seconds_never_negative()
    {
        Assert.Equal(0, ReturnTimeCalculator.RemainingSeconds(0, TestData.T0));
        Assert.Equal(0, ReturnTimeCalculator.RemainingSeconds(TestData.T0 - 10, TestData.T0));
        Assert.Equal(600, ReturnTimeCalculator.RemainingSeconds(TestData.T0 + 600, TestData.T0));
    }

    [Fact]
    public void State_maps_to_wire_names()
    {
        Assert.Equal("sailing", SyncPayloadBuilder.ToWireState(SubmarineState.Sailing));
        Assert.Equal("returned", SyncPayloadBuilder.ToWireState(SubmarineState.Returned));
        Assert.Equal("docked", SyncPayloadBuilder.ToWireState(SubmarineState.Docked));
        Assert.Equal("unknown", SyncPayloadBuilder.ToWireState(SubmarineState.Unknown));
    }
}
