# Start FlipWatch (after install.ps1) and open it in your browser. Ctrl+C stops it.
Set-Location $PSScriptRoot
$url = "http://127.0.0.1:3000"
# Open the browser once the server answers.
Start-Job -ScriptBlock {
  param($url)
  for ($i = 0; $i -lt 60; $i++) {
    try { Invoke-WebRequest "$url/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $url; return } catch { Start-Sleep -Seconds 1 }
  }
} -ArgumentList $url | Out-Null
npm run start:local
