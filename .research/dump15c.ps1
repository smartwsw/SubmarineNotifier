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

foreach ($name in @('Window','WindowSystem','CommandInfo')) {
    $hit = $dalamud | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    Write-Output "=== $($hit.FullName)"
    foreach ($m in $hit.Methods) {
        if (-not $m.IsPublic) { continue }
        if ($m.IsGetter -or $m.IsSetter) { continue }
        $ps = @()
        foreach ($p in $m.Parameters) { $ps += ("{0} {1}" -f $p.ParameterType.Name, $p.Name) }
        Write-Output ("  M {0}({1})" -f $m.Name, ($ps -join ', '))
    }
}

Write-Output "########## IChatGui / IPluginLog methods"
foreach ($name in @('IChatGui','IPluginLog')) {
    $hit = $dalamud | Where-Object { $_.Name -eq $name } | Select-Object -First 1
    Write-Output "=== $($hit.FullName)"
    foreach ($m in $hit.Methods) {
        if (-not $m.IsPublic) { continue }
        if ($m.IsGetter -or $m.IsSetter) { continue }
        $ps = @()
        foreach ($p in $m.Parameters) { $ps += ("{0} {1}" -f $p.ParameterType.Name, $p.Name) }
        Write-Output ("  M {0}({1})" -f $m.Name, ($ps -join ', '))
    }
}
