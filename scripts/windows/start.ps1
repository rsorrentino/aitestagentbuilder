<#
.SYNOPSIS
  Starts the API and the web UI in the background (logs in .\logs) and waits until both answer.
  Use install-service.ps1 instead to run them as Windows services.

  powershell -File scripts\windows\start.ps1
  powershell -File scripts\windows\start.ps1 -Stop
#>
[CmdletBinding()]
param(
  [int]$ApiPort = 3000,
  [int]$UiPort = 4000,
  [int]$TimeoutSeconds = 120,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Logs = Join-Path $Root 'logs'
$PidFile = Join-Path $Logs 'atab.pids'
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

if ($Stop) {
  if (Test-Path $PidFile) {
    Get-Content $PidFile | ForEach-Object {
      # Stop the process and its children (next start spawns a server process)
      $id = [int]$_
      if (Get-Process -Id $id -ErrorAction SilentlyContinue) { & taskkill /PID $id /T /F | Out-Null }
    }
    Remove-Item $PidFile
    Write-Host 'Stopped.'
  } else {
    Write-Host 'Not running (no pid file).'
  }
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $Root 'backend\dist\index.js'))) { throw 'Backend is not built: run scripts\windows\install.ps1 first' }
if (-not (Test-Path (Join-Path $Root 'frontend\.next\BUILD_ID'))) { throw 'Web UI is not built: run scripts\windows\install.ps1 first' }

$backend = Start-Process -FilePath $node -ArgumentList 'dist/index.js' `
  -WorkingDirectory (Join-Path $Root 'backend') -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $Logs 'backend.out.log') -RedirectStandardError (Join-Path $Logs 'backend.err.log')
$frontend = Start-Process -FilePath $node -ArgumentList 'node_modules/next/dist/bin/next', 'start', '-p', "$UiPort" `
  -WorkingDirectory (Join-Path $Root 'frontend') -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput (Join-Path $Logs 'frontend.out.log') -RedirectStandardError (Join-Path $Logs 'frontend.err.log')
@($backend.Id, $frontend.Id) | Set-Content $PidFile

function Wait-Url($url) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
      if ($r.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Seconds 2 }
  }
  return $false
}

Write-Host 'Waiting for the API...'
if (-not (Wait-Url "http://localhost:$ApiPort/health/ready")) {
  Get-Content (Join-Path $Logs 'backend.err.log') -Tail 40 -ErrorAction SilentlyContinue
  Get-Content (Join-Path $Logs 'backend.out.log') -Tail 40 -ErrorAction SilentlyContinue
  throw "The API did not become ready on port $ApiPort (logs in $Logs)"
}
Write-Host 'Waiting for the web UI...'
if (-not (Wait-Url "http://localhost:$UiPort")) {
  Get-Content (Join-Path $Logs 'frontend.err.log') -Tail 40 -ErrorAction SilentlyContinue
  throw "The web UI did not start on port $UiPort (logs in $Logs)"
}
Write-Host "Running: UI http://localhost:$UiPort | API http://localhost:$ApiPort/api/docs | stop with -Stop" -ForegroundColor Green
