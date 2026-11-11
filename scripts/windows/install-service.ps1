<#
.SYNOPSIS
  Runs the API and the web UI at boot, restarted automatically if they stop.

.DESCRIPTION
  With NSSM (https://nssm.cc) on PATH or given with -NssmPath, two real Windows services are created:
  "ATAB-Backend" and "ATAB-Frontend" (visible in services.msc, log rotation included).
  Without NSSM, two Scheduled Tasks with the same names run at startup (built into Windows,
  restart on failure every minute).

  By default they run as LocalSystem. Use -User 'DOMAIN\svc-atab' (and -Password for
  Scheduled Tasks) to run as a dedicated account; it is granted read access to .env.

  Elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -Remove
#>
[CmdletBinding()]
param(
  [int]$UiPort = 4000,
  [string]$NssmPath = '',
  [string]$User = '',
  [string]$Password = '',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Logs = Join-Path $Root 'logs'
$Names = @('ATAB-Backend', 'ATAB-Frontend')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script from an elevated (Administrator) PowerShell.' }

# Node processes of this installation only: their command line holds the absolute script
# path below (a stopped scheduled task can leave its node child running).
$BackendScript = Join-Path $Root 'backend\dist\index.js'
$NextScript = Join-Path $Root 'frontend\node_modules\next\dist\bin\next'
function Stop-AtabNode {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and ($_.CommandLine.Contains($BackendScript) -or $_.CommandLine.Contains($NextScript))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (-not $NssmPath) { $NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source }
$useNssm = [bool]$NssmPath

if ($Remove) {
  foreach ($n in $Names) {
    if (Get-Service $n -ErrorAction SilentlyContinue) {
      if ($useNssm) { & $NssmPath stop $n confirm | Out-Null; & $NssmPath remove $n confirm | Out-Null }
      else { Stop-Service $n -ErrorAction SilentlyContinue; & sc.exe delete $n | Out-Null }
    }
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
    }
  }
  Stop-AtabNode
  Write-Host 'Removed.'
  exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $Root 'backend\dist\index.js'))) { throw 'Run scripts\windows\install.ps1 first' }
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

$apps = @(
  # Args: for NSSM (relative to the working directory). TaskArgs: absolute, so Stop-AtabNode can find the process.
  @{ Name = 'ATAB-Backend'; Dir = Join-Path $Root 'backend'; Args = 'dist\index.js'; TaskArgs = "`"$BackendScript`"";
     Description = 'AI Test Agent Builder API and test executor' },
  @{ Name = 'ATAB-Frontend'; Dir = Join-Path $Root 'frontend'; Args = "node_modules\next\dist\bin\next start -p $UiPort"; TaskArgs = "`"$NextScript`" start -p $UiPort";
     Description = 'AI Test Agent Builder web UI' }
)

if ($User) {
  # The service account needs to read the configuration and write logs, screenshots and browser files.
  & icacls (Join-Path $Root '.env') /grant "${User}:R" | Out-Null
  foreach ($dir in @($Logs, (Join-Path $Root 'backend'), (Join-Path $Root '.playwright-browsers'))) {
    if (Test-Path $dir) { & icacls $dir /grant "${User}:(OI)(CI)M" /T /Q | Out-Null }
  }
}

foreach ($app in $apps) {
  $n = $app.Name
  if ($useNssm) {
    if (Get-Service $n -ErrorAction SilentlyContinue) { & $NssmPath stop $n confirm | Out-Null; & $NssmPath remove $n confirm | Out-Null }
    & $NssmPath install $n $node | Out-Null
    & $NssmPath set $n AppParameters $app.Args | Out-Null
    & $NssmPath set $n AppDirectory $app.Dir | Out-Null
    & $NssmPath set $n Description $app.Description | Out-Null
    & $NssmPath set $n Start SERVICE_AUTO_START | Out-Null
    & $NssmPath set $n AppStdout (Join-Path $Logs "$n.log") | Out-Null
    & $NssmPath set $n AppStderr (Join-Path $Logs "$n.log") | Out-Null
    & $NssmPath set $n AppRotateFiles 1 | Out-Null
    & $NssmPath set $n AppRotateBytes 10485760 | Out-Null
    # Ctrl+C first so the API can finish in-flight work, then stop.
    & $NssmPath set $n AppStopMethodConsole 15000 | Out-Null
    if ($n -eq 'ATAB-Frontend') { & $NssmPath set $n DependOnService 'ATAB-Backend' | Out-Null }
    if ($User) { & $NssmPath set $n ObjectName $User $Password | Out-Null }
    & $NssmPath start $n | Out-Null
    Write-Host "Service $n installed and started (NSSM)."
  } else {
    if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName $n -Confirm:$false
      Stop-AtabNode
    }
    # cmd.exe only adds output redirection to a fixed command line (no user input).
    $log = Join-Path $Logs "$n.log"
    $cmdLine = "/d /c `"`"$node`" $($app.TaskArgs) >> `"$log`" 2>&1`""
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $cmdLine -WorkingDirectory $app.Dir
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    if ($User) {
      Register-ScheduledTask -TaskName $n -Description $app.Description -Action $action -Trigger $trigger -Settings $settings `
        -User $User -Password $Password -RunLevel Highest | Out-Null
    } else {
      $system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
      Register-ScheduledTask -TaskName $n -Description $app.Description -Action $action -Trigger $trigger -Settings $settings `
        -Principal $system | Out-Null
    }
    Start-ScheduledTask -TaskName $n
    Write-Host "Scheduled task $n registered (runs at startup) and started."
  }
}

Write-Host ''
Write-Host "Logs: $Logs" -ForegroundColor Green
if (-not $useNssm) { Write-Host 'Tip: install NSSM (https://nssm.cc) and re-run this script to get real Windows services.' }
