$scriptPath = Join-Path $PSScriptRoot 'start.ps1'
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'LLM Proxy.lnk'

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = 'powershell.exe'
$shortcut.Arguments = "-ExecutionPolicy Bypass -NoExit -File `"$scriptPath`" -OpenUI"
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = 'powershell.exe,0'
$shortcut.Save()

Write-Host "Shortcut created: $shortcutPath"
