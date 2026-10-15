# Runs FlipWatch in the background and restarts it if it stops. Used by the "FlipWatch" scheduled task that
# `install.ps1 -AutoStart` creates. Log: .data\flipwatch.log
$ErrorActionPreference = "Continue"
$project = $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $project ".data") | Out-Null
$log = Join-Path $project ".data\flipwatch.log"
function Write-Log([string]$message) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $message" | Out-File -FilePath $log -Append -Encoding ascii }
if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item $log "$log.old" -Force }
Set-Location $project
while ($true) {
  # Already running (e.g. started by hand with start.ps1): don't fight over the port and database.
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60; continue }
  Write-Log "starting FlipWatch"
  cmd.exe /d /c "node node_modules\next\dist\bin\next start -H 127.0.0.1 -p 3000 >> `"$log`" 2>&1"
  Write-Log "FlipWatch exited with code $LASTEXITCODE; restarting in 15 s"
  Start-Sleep -Seconds 15
}
