$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $taskRoot 'Vivic-Process.ps1')
$taskState = Join-Path $taskRoot '.launcher.json'
$taskLock = Enter-VivicLauncherLock $taskRoot
try {
  if (!(Test-Path -LiteralPath $taskState)) { Write-Host 'This Vivic package is already stopped.'; exit }
  $taskOld = Get-Content -LiteralPath $taskState -Raw | ConvertFrom-Json
  $taskNode = Join-Path $taskRoot 'runtime\node.exe'
  $taskEntry = Join-Path $taskRoot 'apps\local-api\src\index.ts'
  if (Test-VivicOwnedProcess $taskOld $taskNode $taskEntry) {
    # Capture only this API's guardian before closing IPC, then wait for it to
    # finish releasing its engine. The guardian handles forced API termination.
    $taskGuardianCommands = @('processSupervisor.mjs', 'startluxSupervisor.mjs', 'workerSupervisor.mjs') | ForEach-Object { Join-Path $taskRoot ('apps\local-api\src\runtime\' + $_) }
    $taskGuardians = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($taskOld.pid)" -ErrorAction SilentlyContinue | Where-Object {
      $taskCandidate = $_
      $taskCandidate.ExecutablePath -eq $taskNode -and $taskCandidate.CommandLine -and @($taskGuardianCommands | Where-Object { $taskCandidate.CommandLine.Contains($_) }).Count -gt 0
    } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    Stop-Process -Id $taskOld.pid -ErrorAction Stop
    foreach ($taskGuardian in $taskGuardians) {
      if (!$taskGuardian.WaitForExit(8000)) { throw 'Vivic stopped, but its model is still closing. Wait a moment before restarting.' }
    }
    Write-Host 'Vivic and its owned local model have stopped.'
  } else { Write-Host 'This package has no matching running process; stale launcher state was cleared.' }
  Remove-Item -LiteralPath $taskState -Force
} finally { $taskLock.ReleaseMutex(); $taskLock.Dispose() }
