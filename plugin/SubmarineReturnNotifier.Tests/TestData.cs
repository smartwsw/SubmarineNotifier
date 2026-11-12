using SubmarineReturnNotifier.Core.Models;

namespace SubmarineReturnNotifier.Tests;

internal static class TestData
{
    public const string CharacterId = "0000000000000abc";
    public const long T0 = 1_700_000_000;

    public static SubmarineSnapshot Sub(
        int slot,
        string name = "潜艇",
        long returnAt = T0 + 3600,
        SubmarineState state = SubmarineState.Sailing,
        int rank = 10,
        int[]? route = null,
        int hull = 1)
        => new()
        {
            SlotIndex = slot,
            Name = name,
            Rank = rank,
            ReturnAt = returnAt,
            State = state,
            RoutePoints = route ?? new[] { 1, 2, 3 },
            Parts = new Dictionary<string, int>(StringComparer.Ordinal)
            {
                ["hull"] = hull,
                ["stern"] = 2,
                ["bow"] = 3,
                ["bridge"] = 4,
            },
        };

    public static ScanResult Scan(
        string characterId = CharacterId,
        long collectedAt = T0,
        bool workshopLoaded = true,
        params SubmarineSnapshot[] submarines)
        => new()
        {
            CharacterId = characterId,
            CharacterName = "测试角色",
            WorldId = 1000,
            CollectedAt = collectedAt,
            Submarines = submarines,
            WorkshopLoaded = workshopLoaded,
        };
}
