param(
    [string]$Dir = "C:\Users\smart\AppData\Local\Temp\dalamud15"
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $Dir "Mono.Cecil.dll")

function Get-AllTypes([string]$assemblyPath) {
    $asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly($assemblyPath)
    $queue = New-Object System.Collections.Queue
    foreach ($t in $asm.MainModule.Types) { $queue.Enqueue($t) }
    $all = @()
    while ($queue.Count -gt 0) {
        $t = $queue.Dequeue()
        $all += $t
        foreach ($n in $t.NestedTypes) { $queue.Enqueue($n) }
    }
    return ,$all
}

$dalamud = Get-AllTypes (Join-Path $Dir "Dalamud.dll")

Write-Output "########## IUiBuilder events"
$hit = $dalamud | Where-Object { $_.Name -eq 'IUiBuilder' } | Select-Object -First 1
foreach ($e in $hit.Events) { Write-Output "  E $($e.EventType.Name) $($e.Name)" }

foreach ($name in @('Window','WindowSystem','CommandInfo','IDalamudPlugin','IPluginConfiguration')) {
    $hit = $dalamud | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($null -eq $hit) { Write-Output "NOT FOUND: $name"; continue }
    Write-Output "=== $($hit.FullName) (base $($hit.BaseType))"
    foreach ($p in $hit.Properties) { Write-Output "  P $($p.PropertyType.Name) $($p.Name)" }
    foreach ($m in $hit.Methods | Where-Object { $_.IsPublic -and -not $_.IsGetter -and -not $_.IsSetter }) { Write-Output "  M $($m.Name)($([string]::Join(', ', ($m.Parameters | ForEach-Object { $_.ParameterType.Name }))))" }
}

Write-Output "########## IClientState full property list"
$hit = $dalamud | Where-Object { $_.Name -eq 'IClientState' } | Select-Object -First 1
foreach ($p in $hit.Properties) { Write-Output "  P $($p.PropertyType.FullName) $($p.Name)" }
