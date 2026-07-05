$ErrorActionPreference = 'Continue'

$port = 3210
$url = 'http://127.0.0.1:3210/'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $appDir 'ensure-video-editor.log'

function Write-EnsureLog($message) {
  Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

$ready = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3
  $ready = $response.StatusCode -eq 200
} catch {
  $ready = $false
}

if ($ready) {
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = 'C:\Program Files\nodejs\node.exe'
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
  Select-Object -First 1

if (-not $listener -and (Test-Path $node)) {
  Write-EnsureLog 'server not ready, starting node server'
  Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $appDir -WindowStyle Hidden
} elseif ($listener) {
  Write-EnsureLog ("listener exists but health check failed, pid " + $listener.OwningProcess)
} else {
  Write-EnsureLog 'node path not found'
}
