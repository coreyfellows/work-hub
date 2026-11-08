<#
.SYNOPSIS
Update this work-hub checkout and restart what runs it (Windows twin of scripts/update.sh).

.DESCRIPTION
  1. git pull --ff-only (skipped, with a note, when the branch has no upstream or with -NoPull),
     pnpm install --frozen-lockfile, pnpm build (which also regenerates the plugins module)
  2. restart the Scheduled Tasks you installed in \work-hub\ whose name starts with the prefix
     ($env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub; e.g. the server, its TLS front, notes, code), found with
     Get-ScheduledTask, never guessed, and only those that point at this checkout (scripts\windows\lib\Agents.ps1:
     another checkout's tasks under the same prefix are left running); with none it tells you to restart your
     `pnpm start`
  3. the terminal daemon (<prefix>-term) is never restarted here, because that ends every shell: if its code changed
     in this pull, it says so and you restart it when it suits you

Migrations (the core's and each plugin's) run by themselves when the server starts.

.PARAMETER NoPull
Don't pull: install, build and restart what's checked out (e.g. after merging locally).

.PARAMETER NoRestart
Pull, install and build only; print what would be restarted.

.PARAMETER Prefix
Task name prefix (default: $env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub, <user> = $env:USERNAME with
anything but [A-Za-z0-9-] turned into -).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\update.ps1 -NoPull
#>
param(
  [switch]$NoPull,
  [switch]$NoRestart,
  [string]$Prefix = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows
$Prefix = Get-WhPrefix $Prefix

$git = Find-WhTool @('git')
if (-not $git) { Stop-WhScript 'git not found on PATH (winget install Git.Git)' 1 }
$pnpm = Find-WhTool @('pnpm')
if (-not $pnpm) { Stop-WhScript 'pnpm not found on PATH (npm install -g pnpm, or corepack enable)' 1 }

Set-Location -LiteralPath $Repo

# The daemon's code, wherever this checkout keeps it (it moved into the terminals plugin).
$termdFiles = @('plugins/terminals/termd.ts', 'server/termd.ts')

$before = Invoke-WhOutput $git @('rev-parse', 'HEAD')
$branch = Invoke-WhOutput $git @('rev-parse', '--abbrev-ref', 'HEAD')
$upstream = ''
if ($NoPull) {
  Write-Host "-NoPull: building what's checked out ($branch at $($before.Substring(0, 7)))."
} else {
  $r = Invoke-WhQuiet $git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
  if ($r.ExitCode -ne 0 -or -not ($r.Output -join '').Trim()) {
    Write-Host "$branch has no upstream: not pulling; building what's checked out ($($before.Substring(0, 7)))."
  } else {
    $upstream = ($r.Output -join '').Trim()
    Write-Host "Pulling ($branch from $upstream)..."
    Invoke-WhChecked $git @('pull', '--ff-only') 'git pull --ff-only'
  }
}
$after = Invoke-WhOutput $git @('rev-parse', 'HEAD')
if (-not $upstream) {
  # not pulled
} elseif ($before -eq $after) {
  Write-Host "Already up to date at $($after.Substring(0, 7)); installing and building anyway (plugins.json may have changed)."
} else {
  Write-Host "Updated $($before.Substring(0, 7)) -> $($after.Substring(0, 7))."
}

Write-Host 'Installing dependencies...'
Invoke-WhChecked $pnpm @('install', '--frozen-lockfile') 'pnpm install'
Write-Host 'Building...'
Invoke-WhChecked $pnpm @('build') 'pnpm build'

$termdChanged = $false
if ($before -ne $after) {
  $changed = Invoke-WhOutput $git (@('diff', '--name-only', $before, $after, '--') + $termdFiles)
  if ($changed) { $termdChanged = $true }
}

# Tasks in \work-hub\ that start with the prefix and point at this checkout, except the terminal daemon.
$agents = @()
$termInstalled = $false
foreach ($label in @(Get-WhInstalledLabels $Prefix)) {
  if (-not (Test-WhPointsHere $label)) {
    Write-Host "Not restarting ${label}: $(Get-WhForeignReason $label)."
    continue
  }
  if ($label -eq "$Prefix-term") { $termInstalled = $true; continue }
  $agents += $label
}

$restartScript = Join-Path $Repo 'scripts\windows\restart-agent.ps1'
if ($agents.Count -eq 0) {
  Write-Host "No Scheduled Tasks of this checkout starting with $Prefix are installed: restart your ``pnpm start`` (or ``pnpm dev``) to run the new build."
} elseif ($NoRestart) {
  Write-Host "-NoRestart: not restarting $($agents -join ', ')"
  Write-Host "  (each: powershell -NoProfile -ExecutionPolicy Bypass -File `"$restartScript`" -Label <label> -Apply)"
} else {
  foreach ($label in $agents) {
    Write-Host "Restarting $label..."
    Restart-WhAgent $label
  }
}

if ($termdChanged) {
  if ($termInstalled) {
    Write-Host "The terminal daemon changed: restart $Prefix-term when it suits you (this ends every shell):"
    Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$restartScript`" -Label $Prefix-term -Apply"
  } else {
    Write-Host "The terminal daemon changed: restart it when it suits you (this ends every shell). It isn't a Scheduled Task"
    Write-Host 'here: stop its process by its pid (the server logs it when it starts the daemon), then reload a page or restart the server.'
  }
}
Write-Host 'Done.'
