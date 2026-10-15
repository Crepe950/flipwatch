# FlipWatch installer for Windows.
#   Right-click -> "Run with PowerShell", or in PowerShell:   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   Add -AutoStart to start FlipWatch automatically when you sign in to Windows.
param([switch]$AutoStart)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }

Step "Checking Node.js (version 22 or newer is needed)"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js isn't installed. Install the LTS version from https://nodejs.org (or run: winget install OpenJS.NodeJS.LTS), then run this installer again." -ForegroundColor Yellow
  exit 1
}
$major = [int]((node --version).TrimStart("v").Split(".")[0])
if ($major -lt 22) {
  Write-Host "Node.js $(node --version) is too old. Install version 22 or newer from https://nodejs.org, then run this installer again." -ForegroundColor Yellow
  exit 1
}
Write-Host "Node.js $(node --version) found."

Step "Installing FlipWatch's packages (a few minutes the first time)"
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }

Step "Building FlipWatch"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

if (-not (Test-Path ".env.local")) {
  Step "Creating .env.local"
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  @(
    "# FlipWatch settings for this computer. Most settings (AI engine, Facebook, your area) are set in the app.",
    "APP_URL=http://127.0.0.1:3000",
    "SESSION_SECRET=$([Convert]::ToBase64String($bytes))",
    "# Optional: require a password to open FlipWatch",
    "APP_PASSWORD="
  ) | Set-Content -Path ".env.local" -Encoding utf8
}

if ($AutoStart) {
  Step "Starting FlipWatch automatically when you sign in"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\run-background.ps1`"" -WorkingDirectory $PSScriptRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $trigger.Delay = "PT30S"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName "FlipWatch" -Action $action -Trigger $trigger -Settings $settings -Description "FlipWatch marketplace deal finder (http://127.0.0.1:3000)" -Force | Out-Null
  Start-ScheduledTask -TaskName "FlipWatch"
  Write-Host "FlipWatch now starts in the background at sign-in. To undo: Unregister-ScheduledTask FlipWatch"
  Start-Sleep -Seconds 8
  Start-Process "http://127.0.0.1:3000"
} else {
  Step "Starting FlipWatch"
  Write-Host "Opening http://127.0.0.1:3000 - keep this window open while you use FlipWatch (Ctrl+C stops it)."
  & "$PSScriptRoot\start.ps1"
}
