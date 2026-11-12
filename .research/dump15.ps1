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

$dalamud = Join-Path $Dir "Dalamud.dll"
$imgui   = Join-Path $Dir "Dalamud.Bindings.ImGui.dll"
$fcs     = Join-Path $Dir "FFXIVClientStructs.dll"

Write-Output "########## Dalamud.dll types referenced by plugin"
$all = Get-AllTypes $dalamud
foreach ($name in @('IDalamudPluginInterface','IClientState','IFramework','ICommandManager','IChatGui','IPluginLog','IUiBuilder','Window','WindowSystem','CommandInfo','IPluginConfiguration','IDalamudPlugin')) {
    $hit = $all | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    if ($null -eq $hit) { Write-Output "NOT FOUND: $name"; continue }
    Write-Output "=== $($hit.FullName)"
    foreach ($p in $hit.Properties) { if ($p.GetMethod -and $p.GetMethod.IsPublic) { Write-Output "  P $($p.PropertyType.Name) $($p.Name)" } }
    foreach ($e in $hit.Events) { Write-Output "  E $($e.EventType.Name) $($e.Name)" }
}
