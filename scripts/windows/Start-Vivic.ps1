param([switch]$NoOpen, [ValidateRange(1024, 65535)][int]$Port = 18787)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $taskRoot 'Vivic-Process.ps1')
$taskNode = Join-Path $taskRoot 'runtime\node.exe'
$taskEntry = Join-Path $taskRoot 'apps\local-api\src\index.ts'
$taskState = Join-Path $taskRoot '.launcher.json'
$taskReceipt = Get-Content -LiteralPath (Join-Path $taskRoot 'release.json') -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $taskNode -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskReceipt.nodeSha256) { throw 'Node runtime verification failed.' }
$taskLock = Enter-VivicLauncherLock $taskRoot
$taskCreated = $null
try {
  $taskUrl = "http://127.0.0.1:$Port"
  if (Test-Path -LiteralPath $taskState) {
    try { $taskOld = Get-Content -LiteralPath $taskState -Raw | ConvertFrom-Json } catch { throw 'Launcher state is unreadable. Run Stop-Vivic or inspect .launcher.json before retrying.' }
    if (Test-VivicOwnedProcess $taskOld $taskNode $taskEntry) {
      if ($taskOld.port) { $Port = [int]$taskOld.port; $taskUrl = "http://127.0.0.1:$Port" }
      if (!(Wait-VivicHealth $taskUrl $taskOld.pid)) { throw 'Vivic is running but not healthy. Run Stop-Vivic, then Start-Vivic again. See runtime.err.log.' }
      Write-Host "Vivic is ready: $taskUrl/launcher"
      if (!$NoOpen) { Start-Process "$taskUrl/launcher" }
      exit
    }
  }
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is occupied. This launcher did not stop the other app. Use -Port with another port or close that app yourself." }
  $env:PORT = [string]$Port
  $env:VIVIC_ALLOWED_ORIGINS = "$taskUrl,http://localhost:$Port"
  $taskArgs = @('--import', 'tsx', ('"' + $taskEntry + '"'))
  $taskProcess = Start-Process -FilePath $taskNode -ArgumentList $taskArgs -WorkingDirectory (Join-Path $taskRoot 'apps\local-api') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRoot 'runtime.out.log') -RedirectStandardError (Join-Path $taskRoot 'runtime.err.log')
  $taskCreated = @{ pid = $taskProcess.Id; startedAt = $taskProcess.StartTime.ToUniversalTime().ToString('o'); port = $Port }
  $taskCreated | ConvertTo-Json | Set-Content -LiteralPath "$taskState.tmp" -Encoding UTF8
  Move-Item -LiteralPath "$taskState.tmp" -Destination $taskState -Force
  Write-Host 'Starting Vivic and checking its local service...'
  if (!(Wait-VivicHealth $taskUrl $taskProcess.Id)) { throw 'Vivic could not become ready. See runtime.err.log, then retry Start-Vivic.' }
  Write-Host "Vivic is ready: $taskUrl/launcher"
  if (!$NoOpen) { Start-Process "$taskUrl/launcher" }
} catch {
  # A failed start must not leave the newly launched API or model running.
  if ($taskCreated -and (Test-VivicOwnedProcess $taskCreated $taskNode $taskEntry)) { Stop-Process -Id $taskCreated.pid -ErrorAction SilentlyContinue }
  if ($taskCreated) { Remove-Item -LiteralPath $taskState -Force -ErrorAction SilentlyContinue }
  throw
} finally { $taskLock.ReleaseMutex(); $taskLock.Dispose() }
