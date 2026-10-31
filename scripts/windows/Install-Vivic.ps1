param([string]$Destination, [switch]$NoShortcuts)
$ErrorActionPreference = 'Stop'
$taskSource = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path)).TrimEnd('\')
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$taskInstall = if ($Destination) { [IO.Path]::GetFullPath($Destination).TrimEnd('\') } else { Join-Path $env:LOCALAPPDATA "Vivic\$taskStamp" }
if ($taskInstall -eq $taskSource -or $taskInstall.StartsWith($taskSource + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an install directory outside the source package.' }
if (Test-Path -LiteralPath $taskInstall) { throw 'The install destination already exists. Choose a new directory to preserve the existing installation.' }
New-Item -ItemType Directory -Path $taskInstall | Out-Null
& robocopy.exe $taskSource $taskInstall /E /XF '.env' '.env.*' '.launcher.json' '.launcher.json.tmp' '*.log' /XD '.cache' '.git' /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'Vivic installation copy failed. The source package remains available; retry with a new destination.' }
if (!$NoShortcuts) {
  $taskShell = New-Object -ComObject WScript.Shell
  foreach ($taskAction in @('Start', 'Stop')) {
    $taskShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ("Vivic $taskAction.lnk")
    if (Test-Path -LiteralPath $taskShortcutPath) { $taskShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ("Vivic $taskAction $taskStamp.lnk") }
    $taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
    $taskShortcut.TargetPath = Join-Path $taskInstall ("$taskAction-Vivic.cmd")
    $taskShortcut.WorkingDirectory = $taskInstall
    $taskShortcut.Save()
  }
}
Write-Host "Installed: $taskInstall"
Write-Host 'Use Start-Vivic.cmd in that folder to open the launcher. Existing desktop shortcuts are preserved.'
