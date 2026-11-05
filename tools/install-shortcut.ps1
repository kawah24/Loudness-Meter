# Creates (or re-creates) the "Loudness Meter" desktop shortcut.
# Works from wherever this folder sits, so it survives a move.

$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Loudness Meter.lnk'

$icon = Join-Path $root 'Loudness Meter.ico'
$launcher = Join-Path $root 'tools\launch.vbs'

if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }
if (-not (Test-Path $icon)) { throw "icon not found: $icon" }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$sc.Arguments = '"' + $launcher + '"'
$sc.IconLocation = $icon + ',0'
$sc.WorkingDirectory = $root
$sc.Description = 'ITU-R BS.1770-4 / EBU R128 loudness meter'
$sc.WindowStyle = 1
$sc.Save()

Write-Output "shortcut: $lnk"
Write-Output ("target : " + $sc.TargetPath)
Write-Output ("args   : " + $sc.Arguments)
Write-Output ("icon   : " + $sc.IconLocation)
Write-Output ("start  : " + $sc.WorkingDirectory)
