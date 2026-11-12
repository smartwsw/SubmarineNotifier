param(
    [string]$Dir = "C:\Users\smart\AppData\Roaming\XIVLauncher\addon\Hooks\dev"
)
Add-Type -Path (Join-Path $Dir "Mono.Cecil.dll")

function Dump-Type([string]$assemblyPath, [string[]]$typeNames) {
    $asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($assemblyPath)
    $c = $asm.MainModule.Types
    $queue = New-Object System.Collections.Queue
    foreach ($t in $c) { $queue.Enqueue($t) }
    $all = @()
    while ($queue.Count -gt 0) {
        $t = $queue.Dequeue()
        $all += $t
        foreach ($n in $t.NestedTypes) { $queue.Enqueue($n) }
    }
    foreach ($name in $typeNames) {
        $hit = $all | Where-Object { $_.FullName -eq $name -or $_.Name -eq $name } | Select-Object -First 1
        if ($null -eq $hit) { Write-Output "NOT FOUND: $name"; continue }
        Write-Output "===== $($hit.FullName) (base: $($hit.BaseType)) size: $((($hit.CustomAttributes | Where-Object { $_.AttributeType.Name -eq 'StructLayoutAttribute' } | ForEach-Object { $_.ToString() })))"
        foreach ($f in $hit.Fields) {
            $off = $f.CustomAttributes | Where-Object { $_.AttributeType.Name -eq 'FieldOffsetAttribute' } | ForEach-Object { $_.ConstructorArguments[0].Value }
            $arr = if ($f.CustomAttributes | Where-Object { $_.AttributeType.Name -eq 'FixedSizeArrayAttribute' }) { "[FixedSizeArray]" } else { "" }
            Write-Output ("  F 0x{0:X} {1} {2} {3}" -f [int]$off, $f.FieldType, $f.Name, $arr)
        }
        foreach ($p in $hit.Properties) { Write-Output "  P $($p.PropertyType) $($p.Name)" }
        foreach ($m in $hit.Methods | Where-Object { $_.IsPublic -and -not $_.IsGetter -and -not $_.IsSetter }) { Write-Output "  M $($m)" }
    }
}

Write-Output "########## FFXIVClientStructs"
Dump-Type (Join-Path $Dir "FFXIVClientStructs.dll") @(
    "HousingWorkshopSubmersibleSubData",
    "HousingWorkshopSubmersibleData",
    "WorkshopTerritory",
    "HousingManager"
)

Write-Output "########## Lumina.Excel"
Dump-Type (Join-Path $Dir "Lumina.Excel.dll") @(
    "SubmarineExploration",
    "SubmarineMap"
)

Write-Output "########## Dalamud assembly attributes"
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $Dir "Dalamud.dll"))
foreach ($a in $asm.CustomAttributes) {
    if ($a.AttributeType.Name -match 'ApiLevel|Version|InformationalVersion') {
        Write-Output "$($a.AttributeType.Name): $($a.ConstructorArguments[0].Value)"
    }
}
