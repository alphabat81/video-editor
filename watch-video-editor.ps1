$ErrorActionPreference = 'Continue'

$port = 3210
$url = 'http://127.0.0.1:3210/'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $appDir 'watch-video-editor.log'
$lockPath = Join-Path $appDir 'watch-video-editor.lock'

function Write-WatchLog($message) {
  Add-Content -LiteralPath $log -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

try {
  $lockStream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-WatchLog 'another watcher is already running'
  exit 0
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = 'C:\Program Files\nodejs\node.exe'
}

Write-WatchLog 'watcher started'
Write-WatchLog ("node path: " + $node)

$openedBrowser = $false

try {
  while ($true) {
    $ready = $false
    try {
      $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3
      $ready = $response.StatusCode -eq 200
    } catch {
      $ready = $false
    }

    if (-not $ready) {
      $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' } |
        Select-Object -First 1

      if (-not $listener -and (Test-Path $node)) {
        Write-WatchLog 'server not ready, starting node server'
        Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $appDir -WindowStyle Hidden
      } elseif ($listener) {
        Write-WatchLog ("listener exists but health check failed, pid " + $listener.OwningProcess)
      } else {
        Write-WatchLog 'node path not found'
      }

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
    }

    if ($ready -and -not $openedBrowser) {
      Write-WatchLog ("opening browser: " + $url)
      Start-Process -FilePath $url
      $openedBrowser = $true
    }

    Start-Sleep -Seconds 30
  }
} finally {
  if ($lockStream) {
    $lockStream.Close()
    $lockStream.Dispose()
  }
}
