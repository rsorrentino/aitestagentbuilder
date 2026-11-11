<#
.SYNOPSIS
  Runs AI Test Agent Builder (API + web UI) at boot on Windows, restarted automatically.
  Normally called through npm from an elevated prompt:

    npm run service:install
    npm run service:install -- --user CONTOSO\svc-atab --password ...
    npm run service:uninstall

.DESCRIPTION
  The service runs "node scripts\atab.mjs start" - the same as "npm start" - which supervises
  the API and the web UI and exits with an error if either stops, so Windows restarts it.

  With NSSM (https://nssm.cc) on PATH or given with -NssmPath: a Windows service "ATAB"
  (services.msc, rotating logs in logs\). Without NSSM, or with -NoNssm: a Scheduled Task "ATAB"
  that starts at boot and restarts on failure.
  By default it runs as LocalSystem; -User runs it as a dedicated account (granted access to
  .env, logs, screenshots and the browser folder).
#>
[CmdletBinding()]
param(
  [string]$NssmPath = '',
  [string]$User = '',
  [string]$Password = '',
  [switch]$NoNssm,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Logs = Join-Path $Root 'logs'
$Name = 'ATAB'
$Script = Join-Path $Root 'scripts\atab.mjs'
# Names used by earlier versions of this script
$OldNames = @('ATAB-Frontend', 'ATAB-Backend')

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated (Administrator) prompt.' }

if (-not $NssmPath -and -not $NoNssm) { $NssmPath = (Get-Command nssm -ErrorAction SilentlyContinue).Source }
$useNssm = [bool]$NssmPath -and -not $NoNssm

# Node processes of this installation only: identified by the absolute paths in their command line.
function Stop-AtabNode {
  $paths = @($Script, (Join-Path $Root 'backend\dist\index.js'), (Join-Path $Root 'frontend\node_modules\next\dist\bin\next'))
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $cmd = $_.CommandLine
    $cmd -and ($paths | Where-Object { $cmd.Contains($_) })
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Remove-Atab([string]$n) {
  if (Get-Service $n -ErrorAction SilentlyContinue) {
    if ($NssmPath) { & $NssmPath stop $n confirm | Out-Null; & $NssmPath remove $n confirm | Out-Null }
    else { Stop-Service $n -Force -ErrorAction SilentlyContinue; & sc.exe delete $n | Out-Null }
  }
  if (Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $n -Confirm:$false
  }
}

foreach ($n in @($Name) + $OldNames) { Remove-Atab $n }
Stop-AtabNode
if ($Remove) { Write-Host 'Removed.'; exit 0 }

$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $Root 'backend\dist\index.js'))) { throw 'Not built yet: run "npm run setup -- --production" first' }
New-Item -ItemType Directory -Force -Path $Logs | Out-Null

if ($User) {
  & icacls (Join-Path $Root '.env') /grant "${User}:R" | Out-Null
  foreach ($dir in @($Logs, (Join-Path $Root 'backend'), (Join-Path $Root 'frontend\.next'), (Join-Path $Root '.playwright-browsers'))) {
    if (Test-Path $dir) { & icacls $dir /grant "${User}:(OI)(CI)M" /T /Q | Out-Null }
  }
}

if ($useNssm) {
  & $NssmPath install $Name $node | Out-Null
  # Relative to AppDirectory: PowerShell 5.1 mangles quoted arguments to native programs.
  & $NssmPath set $Name AppParameters 'scripts\atab.mjs start' | Out-Null
  & $NssmPath set $Name AppDirectory $Root | Out-Null
  & $NssmPath set $Name DisplayName 'AI Test Agent Builder' | Out-Null
  & $NssmPath set $Name Description 'AI Test Agent Builder API and web UI' | Out-Null
  & $NssmPath set $Name Start SERVICE_AUTO_START | Out-Null
  & $NssmPath set $Name AppStdout (Join-Path $Logs 'atab.log') | Out-Null
  & $NssmPath set $Name AppStderr (Join-Path $Logs 'atab.log') | Out-Null
  & $NssmPath set $Name AppRotateFiles 1 | Out-Null
  & $NssmPath set $Name AppRotateBytes 10485760 | Out-Null
  & $NssmPath set $Name AppStopMethodConsole 15000 | Out-Null
  & $NssmPath set $Name AppExit Default Restart | Out-Null
  & $NssmPath set $Name AppRestartDelay 5000 | Out-Null
  if ($User) { & $NssmPath set $Name ObjectName $User $Password | Out-Null }
  & $NssmPath start $Name | Out-Null
  Write-Host "Windows service '$Name' installed and started (NSSM). Logs: $Logs\atab.log"
} else {
  # cmd.exe only adds output redirection to a fixed command line (no user input).
  $log = Join-Path $Logs 'atab.log'
  $cmdLine = "/d /c `"`"$node`" `"$Script`" start >> `"$log`" 2>&1`""
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument $cmdLine -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  if ($User) {
    Register-ScheduledTask -TaskName $Name -Description 'AI Test Agent Builder API and web UI' -Action $action -Trigger $trigger `
      -Settings $settings -User $User -Password $Password -RunLevel Highest | Out-Null
  } else {
    $system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $Name -Description 'AI Test Agent Builder API and web UI' -Action $action -Trigger $trigger `
      -Settings $settings -Principal $system | Out-Null
  }
  Start-ScheduledTask -TaskName $Name
  Write-Host "Scheduled task '$Name' registered (starts at boot) and started. Logs: $log"
  Write-Host 'Tip: with NSSM (https://nssm.cc) on PATH you get a real Windows service with automatic restarts.'
}
