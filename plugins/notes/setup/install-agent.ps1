<#
.SYNOPSIS
Install (or remove) a Windows Scheduled Task that keeps SilverBullet serving your notes folder for the notes plugin
(the Windows twin of install-agent.sh beside it).

.DESCRIPTION
  task     \work-hub\<prefix>-notes, prefix $env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub (at logon, hidden)
  listens  127.0.0.1:<port> only (default 18744), under the URL prefix /notes
  serves   <notes dir> (default <home>\notes), single-space mode, no SilverBullet login, shell commands off

There is no SilverBullet login because it only listens on loopback: anything that can reach it is already on this PC.
With LAN access on, the front proxy (scripts\windows\setup-lan.ps1) sends /notes to it only after work-hub's sign-in.
Never change the bind address to anything but 127.0.0.1.

Dry run by default (prints what it would do); -Apply installs or reinstalls (idempotent), -Uninstall removes it.
Each value: the parameter, else its env var (WORK_HUB_NOTES_LOCAL_PORT, WORK_HUB_NOTES_NOTES_DIR,
WORK_HUB_NOTES_SILVERBULLET, WORK_HUB_LAUNCHD_PREFIX), else plugins.json settings.notes.{localPort,notesDir,silverbullet},
else the default. The task is stamped with this checkout (WORK_HUB_REPO in its Description); one that points at another
checkout is never stopped, replaced or removed unless -Adopt is given (scripts\windows\lib\Agents.ps1).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File plugins\notes\setup\install-agent.ps1 -Apply
#>
param(
  [switch]$Apply,
  [switch]$Uninstall,
  [string]$Port = '',
  [string]$NotesDir = '',
  [string]$Bin = '',
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
$Port = Select-WhFirst $Port $env:WORK_HUB_NOTES_LOCAL_PORT (Get-WhPluginSetting $cfg 'notes' 'localPort') '18744'
$NotesDir = Select-WhFirst $NotesDir $env:WORK_HUB_NOTES_NOTES_DIR (Get-WhPluginSetting $cfg 'notes' 'notesDir') (Join-Path $userHome 'notes')
$Bin = Select-WhFirst $Bin $env:WORK_HUB_NOTES_SILVERBULLET (Get-WhPluginSetting $cfg 'notes' 'silverbullet') `
  (Find-WhTool @('silverbullet')) (Join-Path $userHome '.local\bin\silverbullet.exe')
$Prefix = Get-WhPrefix $Prefix
$urlPrefix = '/notes'

if ($Port -notmatch '^[0-9]+$') { Stop-WhScript "-Port must be a number (got $Port)" 2 }
if (-not (Test-WhAbsolutePath $NotesDir)) { Stop-WhScript "-NotesDir must be an absolute path (got $NotesDir)" 2 }

$label = "$Prefix-notes"
$log = Get-WhAgentLog $label

if ($Uninstall) {
  if (-not (Test-WhOwned 'apply' @($label) ([bool]$Adopt))) { exit 1 }
  Remove-WhAgent $label
  Write-Host "Removed $label (your notes in $NotesDir are untouched)."
  exit 0
}

$launcher = New-WhLauncherText $label $Bin @('--single', '-L', '127.0.0.1', '-p', $Port, $NotesDir) `
  ([ordered]@{ SB_URL_PREFIX = $urlPrefix; SB_SHELL_BACKEND = 'off' }) @() $NotesDir

$problems = $false
if (-not (Test-Path -LiteralPath $Bin -PathType Leaf)) {
  Write-WhError "SilverBullet not found at ${Bin}: install it (see SETUP.md) or pass -Bin."
  $problems = $true
}
if ((Test-WhListening ([int]$Port)) -and -not (Test-WhAgentRunning $label)) {
  Write-WhError "Port $Port is already in use by something else: pick another with -Port."
  $problems = $true
}

if (-not $Apply) {
  Write-Host 'Dry run. With -Apply this would:'
  if (-not (Test-Path -LiteralPath $NotesDir -PathType Container)) { Write-Host "  create $NotesDir" }
  if (Test-WhAgentRunning $label) { Write-Host "  stop the running $label" }
  [void](Test-WhOwned 'dry-run' @($label) ([bool]$Adopt))
  Show-WhAgentPlan $label $launcher
  Write-Host "  start it and wait for 127.0.0.1:$Port; log: $log"
  Write-Host "Then point the notes plugin at http://127.0.0.1:$Port$urlPrefix (see SETUP.md)."
  if ($problems) { Stop-WhScript 'Fix the problems above before -Apply.' 1 }
  exit 0
}

if ($problems) { exit 1 }
if (-not (Test-WhOwned 'apply' @($label) ([bool]$Adopt))) { exit 1 }
New-Item -ItemType Directory -Force -Path $NotesDir | Out-Null
Install-WhAgent $label $launcher $NotesDir
for ($i = 0; $i -lt 40; $i++) {
  if (Test-WhListening ([int]$Port)) {
    Write-Host "$label is serving $NotesDir at http://127.0.0.1:$Port$urlPrefix"
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Stop-WhScript "$label didn't start listening on 127.0.0.1:$Port; see $log" 1
