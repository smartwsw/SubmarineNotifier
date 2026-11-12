param([string]$Dir = "C:\Users\smart\AppData\Roaming\XIVLauncher\addon\Hooks\dev")
Add-Type -Path (Join-Path $Dir "Mono.Cecil.dll")
$asm = [Mono.Cecil.AssemblyDefinition]::ReadAssembly((Join-Path $Dir "Dalamud.dll"))
$all = @()
$q = New-Object System.Collections.Queue
foreach ($t in $asm.MainModule.Types) { $q.Enqueue($t) }
while ($q.Count -gt 0) { $t = $q.Dequeue(); $all += $t; foreach ($n in $t.NestedTypes) { $q.Enqueue($n) } }
$wanted = @(
  "Dalamud.Plugin.Services.IClientState",
  "Dalamud.Plugin.Services.IPlayerState",
  "Dalamud.Plugin.Services.IDataManager",
  "Dalamud.Plugin.Services.IPluginLog",
  "Dalamud.Plugin.Services.IAddonLifecycle",
  "Dalamud.Plugin.IDalamudPluginInterface",
  "Dalamud.Plugin.Ilmb.IUnsafeLocalization?",
  "Dalamud.Game.ClientState.Objects.SubKinds.IPlayerCharacter",
  "Dalamud.Plugin.Services.IObjectTable",
  "Dalamud.Plugin.Services.IFramework",
  "Dalamud.Plugin.Services.ICommandManager",
  "Dalamud.Plugin.Services.IUnsafeLocalization?",
  "Dalamud.Plugin.Services.ISeStringEvaluator",
  "Dalamud.Plugin.Configuration.IPluginConfiguration",
  "Dalamud.Plugin.IAsyncDalamudPlugin?"
)
foreach ($name in $wanted) {
  $hit = $all | Where-Object { $_.FullName -eq $name } | Select-Object -First 1
  if ($null -eq $hit) { Write-Output "NOT FOUND $name"; continue }
  Write-Output "===== $($hit.FullName)"
  foreach ($p in $hit.Properties) { Write-Output "  P $($p.PropertyType) $($p.Name)" }
  foreach ($m in $hit.Methods) { if ($m.IsPublic -and -not $m.IsGetter -and -not $m.IsSetter) { Write-Output "  M $($m)" } }
  foreach ($e in $hit.Events) { Write-Output "  E $($e.EventType) $($e.Name)" }
}
Write-Output "===== ALL IClientState-like interfaces"
$all | Where-Object { $_.Name -match '^(IClientState|IPlayerState|ISeStringEvaluator|IAddonLifecycle|IDataManager)$' } | ForEach-Object { Write-Output $_.FullName }
Write-Output "===== IDalamudPluginInterface in assembly"
$all | Where-Object { $_.Name -eq 'IDalamudPluginInterface' } | ForEach-Object { Write-Output $_.FullName }
