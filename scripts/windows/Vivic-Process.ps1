# Exact executable, command line and creation time prevent stale PID reuse from
# opening or stopping another instance. This helper never scans by process name.
function Test-VivicOwnedProcess($Record, [string]$Executable, [string]$Entry) {
  if (!$Record -or !([string]$Record.pid -match '^[1-9][0-9]*$') -or !$Record.startedAt) { return $false }
  $taskCandidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($Record.pid)" -ErrorAction SilentlyContinue
  if (!$taskCandidate -or $taskCandidate.ExecutablePath -ne $Executable -or !$taskCandidate.CommandLine -or !$taskCandidate.CommandLine.Contains($Entry)) { return $false }
  try { return (Get-Process -Id $Record.pid -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') -eq $Record.startedAt } catch { return $false }
}
function Enter-VivicLauncherLock([string]$Root) {
  $taskHasher = [System.Security.Cryptography.SHA256]::Create()
  try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Root.ToLowerInvariant()))).Replace('-', '') } finally { $taskHasher.Dispose() }
  $taskMutex = New-Object System.Threading.Mutex($false, "Local\Vivic-$taskHash")
  try { $taskHeld = $taskMutex.WaitOne(45000) } catch [System.Threading.AbandonedMutexException] { $taskHeld = $true }
  if (!$taskHeld) { $taskMutex.Dispose(); throw 'Another Vivic launcher is busy. Wait a moment and retry.' }
  return $taskMutex
}
function Wait-VivicHealth([string]$Url, [int]$ProcessId) {
  for ($taskAttempt = 0; $taskAttempt -lt 60; $taskAttempt++) {
    if (!(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $false }
    try {
      $taskHealth = Invoke-RestMethod -Uri "$Url/healthz" -TimeoutSec 1
      if ($taskHealth.service -eq 'vivic-local-api') { return $true }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
