<#
.SYNOPSIS
Restart one of this checkout's work-hub Scheduled Tasks (the Windows `launchctl kickstart -k`).

.DESCRIPTION
Stops the task in \work-hub\ named -Label and everything its launcher started (by pid), then starts it again. Refused
when the task points at another checkout, unless -Adopt (scripts\windows\lib\Agents.ps1). update.ps1 restarts the
others by itself and prints this command for <prefix>-term, the terminal daemon: restarting that ends every shell.
Dry run by default.

.PARAMETER Label
The task name, e.g. com.<user>.work-hub-term.

.PARAMETER Apply
Restart it (without it: say what would happen).

.PARAMETER Adopt
Restart it even if it points at another checkout.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\restart-agent.ps1 -Label com.me.work-hub-term -Apply
#>
param(
  [string]$Label = '',
  [switch]$Apply,
  [switch]$Adopt
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows

if (-not $Label) { Stop-WhScript 'A task name is required: -Label <name> (see Task Scheduler, folder \work-hub\)' 2 }
if (-not (Get-WhAgentTask $Label)) { Stop-WhScript "No Scheduled Task $WhTaskPath$Label" 1 }

if (-not $Apply) {
  Write-Host 'Dry run (nothing changed):'
  [void](Test-WhOwned 'dry-run' @($Label) ([bool]$Adopt))
  Write-Host "  would stop $WhTaskPath$Label and what it started, then start it again"
  if ($Label -like '*-term') { Write-Host '  (this is the terminal daemon: restarting it ends every shell)' }
  Write-Host 'Re-run with -Apply.'
  exit 0
}

if (-not (Test-WhOwned 'apply' @($Label) ([bool]$Adopt))) { exit 1 }
Restart-WhAgent $Label
Write-Host "Restarted $Label."
