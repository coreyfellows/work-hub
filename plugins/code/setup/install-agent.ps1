<#
.SYNOPSIS
Install (or remove) a Windows Scheduled Task that keeps VS Code's `serve-web` running for the code plugin (the Windows
twin of install-agent.sh beside it).

.DESCRIPTION
  task     \work-hub\<prefix>-code, prefix $env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub (at logon, hidden)
  listens  127.0.0.1:<port> only (default 18743), under the base path /code
  token    a connection token in <token file> (default <home>\.local\state\vscode-serve-web.token, the plugin's
           default), created here (readable by you only) if missing and never printed. work-hub reads it and hands it
           only to its own UI.

With LAN access on, the front proxy (scripts\windows\setup-lan.ps1) sends /code to it only after work-hub's sign-in.
Never change the bind address to anything but 127.0.0.1.

Dry run by default (prints what it would do); -Apply installs or reinstalls (idempotent), -Uninstall removes it (the
token file is kept; delete it yourself if you want a new one).
Each value: the parameter, else its env var (WORK_HUB_CODE_LOCAL_PORT, WORK_HUB_CODE_VSCODE_TOKEN_FILE,
WORK_HUB_CODE_CLI, WORK_HUB_LAUNCHD_PREFIX), else plugins.json settings.code.{localPort,vscodeTokenFile,cli}, else the
default. The task is stamped with this checkout (WORK_HUB_REPO in its Description); one that points at another checkout
is never stopped, replaced or removed unless -Adopt is given (scripts\windows\lib\Agents.ps1).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\code\setup\install-agent.ps1 -Apply
#>
param(
  [switch]$Apply,
  [switch]$Uninstall,
  [string]$Port = '',
  [string]$TokenFile = '',
  [string]$Cli = '',
  [string]$Prefix = '',
  [switch]$Adopt
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).ProviderPath
. (Join-Path $Repo 'scripts\windows\lib\Agents.ps1')
Assert-WhWindows
if ($Apply -and $Uninstall) { Stop-WhScript 'Pass -Apply or -Uninstall, not both.' 2 }
if (-not (Test-WhTaskSupport)) { Stop-WhScript 'The ScheduledTasks PowerShell module is missing (Windows 8 / Server 2012 or later has it).' 1 }

# plugins.json settings for this plugin (the same ones setup-lan.ps1 reads), so both write the same task.
$cfg = Read-WhPluginsConfig (Get-WhPluginsFile)
$userHome = Get-WhHome
$Port = Select-WhFirst $Port $env:WORK_HUB_CODE_LOCAL_PORT (Get-WhPluginSetting $cfg 'code' 'localPort') '18743'
$TokenFile = Select-WhFirst $TokenFile $env:WORK_HUB_CODE_VSCODE_TOKEN_FILE (Get-WhPluginSetting $cfg 'code' 'vscodeTokenFile') `
  (Join-Path $userHome '.local\state\vscode-serve-web.token')
$Cli = Select-WhFirst $Cli $env:WORK_HUB_CODE_CLI (Get-WhPluginSetting $cfg 'code' 'cli') (Get-WhDefaultVsCodeCli)
$Prefix = Get-WhPrefix $Prefix
$basePath = '/code'

if ($Port -notmatch '^[0-9]+$') { Stop-WhScript "-Port must be a number (got $Port)" 2 }
if (-not (Test-WhAbsolutePath $TokenFile)) { Stop-WhScript "-TokenFile must be an absolute path (got $TokenFile)" 2 }

$label = "$Prefix-code"
$log = Get-WhAgentLog $label

if ($Uninstall) {
  if (-not (Test-WhOwned 'apply' @($label) ([bool]$Adopt))) { exit 1 }
  Remove-WhAgent $label
  Write-Host "Removed $label (the token file $TokenFile is kept)."
  exit 0
}

$launcher = New-WhLauncherText $label $Cli @('serve-web', '--accept-server-license-terms', '--host', '127.0.0.1',
  '--port', $Port, '--server-base-path', $basePath, '--connection-token-file', $TokenFile) $null @() $Repo

function Test-TokenPresent { return ((Test-Path -LiteralPath $TokenFile -PathType Leaf) -and (Get-Item -LiteralPath $TokenFile).Length -gt 0) }

$problems = $false
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) {
  Write-WhError "VS Code CLI not found at ${Cli}: install VS Code or the standalone CLI (see SETUP.md), or pass -Cli."
  $problems = $true
}
if ((Test-WhListening ([int]$Port)) -and -not (Test-WhAgentRunning $label)) {
  Write-WhError "Port $Port is already in use by something else: pick another with -Port."
  $problems = $true
}

if (-not $Apply) {
  Write-Host 'Dry run. With -Apply this would:'
  if (Test-TokenPresent) { Write-Host "  keep the existing token in $TokenFile" } else { Write-Host "  create a connection token in $TokenFile (readable by you only)" }
  if (Test-WhAgentRunning $label) { Write-Host "  stop the running $label" }
  [void](Test-WhOwned 'dry-run' @($label) ([bool]$Adopt))
  Show-WhAgentPlan $label $launcher
  Write-Host "  start it and wait for 127.0.0.1:$Port; log: $log"
  Write-Host "Then point the code plugin at http://127.0.0.1:$Port$basePath (see SETUP.md)."
  if ($problems) { Stop-WhScript 'Fix the problems above before -Apply.' 1 }
  exit 0
}

if ($problems) { exit 1 }
if (-not (Test-WhOwned 'apply' @($label) ([bool]$Adopt))) { exit 1 }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TokenFile) | Out-Null
if (-not (Test-TokenPresent)) {
  # Restricted to you before the token goes in.
  Write-WhUtf8File $TokenFile ''
  Protect-WhPath $TokenFile
  Write-WhUtf8File $TokenFile ((New-WhRandomToken 24 'hex') + "`n")
  Write-Host "Created a connection token in $TokenFile."
}
Protect-WhPath $TokenFile
Install-WhAgent $label $launcher $Repo
for ($i = 0; $i -lt 60; $i++) {
  if (Test-WhListening ([int]$Port)) {
    Write-Host "$label is serving VS Code at http://127.0.0.1:$Port$basePath"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Stop-WhScript "$label didn't start listening on 127.0.0.1:$Port (the first start downloads the VS Code server); see $log" 1
