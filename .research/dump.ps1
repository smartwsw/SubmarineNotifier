$ErrorActionPreference='Stop'
$dir="$env:APPDATA\XIVLauncher\addon\Hooks\dev"
$asm=[Reflection.Assembly]::LoadFrom("$dir\Lumina.Excel.dll")
$types = $asm.GetTypes() | Where-Object { $_.Name -like '*Submarine*' }
foreach($t in $types){ "TYPE $($t.FullName)" }
$t = $types | Where-Object { $_.Name -eq 'SubmarineExploration' }
if($t){ "--- SubmarineExploration" ; $t.GetProperties() | ForEach-Object { $_.PropertyType.Name + ' ' + $_.Name } }
