param([string]$Dir = "C:\Users\smart\AppData\Local\Temp\dalamud15")
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $Dir "Mono.Cecil.dll")

function Dump-Assembly([string]$path, [string[]]$names) {
    $asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($path)
    $queue = New-Object System.Collections.Queue
    foreach ($t in $asm.MainModule.Types) { $queue.Enqueue($t) }
    $all = @()
    while ($queue.Count -gt 0) {
        $t = $queue.Dequeue(); $all += $t
        foreach ($n in $t.NestedTypes) { $queue.Enqueue($n) }
    }
    foreach ($name in $names) {
        $hits = $all | Where-Object { $_.Name -eq $name }
        if (-not $hits) { Write-Output "NOT FOUND: $name"; continue }
        foreach ($hit in $hits) {
            Write-Output "=== $($hit.FullName)  base=$($hit.BaseType) isValueType=$($hit.IsValueType)"
            foreach ($f in $hit.Fields) {
                if (-not $f.IsPublic) { continue }
                $off = $f.CustomAttributes | Where-Object { $_.AttributeType.Name -eq 'FieldOffsetAttribute' } | ForEach-Object { $_.ConstructorArguments[0].Value }
                $fixed = if ($f.CustomAttributes | Where-Object { $_.AttributeType.Name -eq 'FixedSizeArrayAttribute' }) { "[fixed]" } else { "" }
                Write-Output ("  F 0x{0:X} {1} {2} {3}" -f [int]$off, $f.FieldType.Name, $f.Name, $fixed)
            }
            foreach ($p in $hit.Properties) { Write-Output "  P $($p.PropertyType.Name) $($p.Name)" }
        }
    }
}

Write-Output "########## FFXIVClientStructs: Housing / Submersible"
Dump-Assembly (Join-Path $Dir "FFXIVClientStructs.dll") @(
    'HousingManager','HousingWorkshopTerritory','HousingWorkshopSubmersibleData','HousingWorkshopSubmersibleSubData'
)

Write-Output "########## Dalamud: plugin API entry points"
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $Dir "Dalamud.dll"))
$queue = New-Object System.Collections.Queue
foreach ($t in $asm.MainModule.Types) { $queue.Enqueue($t) }
$all = @()
while ($queue.Count -gt 0) { $t = $queue.Dequeue(); $all += $t; foreach ($n in $t.NestedTypes) { $queue.Enqueue($n) } }

foreach ($name in @('IDalamudPluginInterface','ICommandManager','IChatGui','IDalamudPlugin')) {
    $hit = $all | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    Write-Output "=== $($hit.FullName)"
    if ($hit -is [Mono.Cecil.TypeDefinition]) {
        foreach ($m in $hit.Methods) {
            if (-not $m.IsPublic -or $m.IsGetter -or $m.IsSetter) { continue }
            $ps = @(); foreach ($p in $m.Parameters) { $ps += ("{0} {1}" -f $p.ParameterType.Name, $p.Name) }
            Write-Output ("  M {0}({1})" -f $m.Name, ($ps -join ', '))
        }
    }
}
