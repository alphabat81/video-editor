$ErrorActionPreference = 'Continue'

$port = 3210
$url = 'http://127.0.0.1:3210/'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $appDir 'start-video-editor.log'

function Write-StartLog($message) {
  Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

Write-StartLog 'startup script entered'

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source

if (-not $node) {
  $localNode = Join-Path $appDir 'runtime\node.exe'
  if (Test-Path $localNode) {
    $node = $localNode
  } else {
    $node = 'C:\Program Files\nodejs\node.exe'
  }
}

Write-StartLog ("node path: " + $node)

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
  Select-Object -First 1

if (-not $listener -and (Test-Path $node)) {
  Write-StartLog 'starting node server'
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $appDir -WindowStyle Hidden
} elseif ($listener) {
  Write-StartLog ("server already listening, pid " + $listener.OwningProcess)
} else {
  Write-StartLog 'node path not found'
}

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      $ready = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if ($ready) {
  Write-StartLog ("opening browser: " + $url)
  Start-Process -FilePath $url
} else {
  Write-StartLog 'server did not become ready, browser not opened'
}
