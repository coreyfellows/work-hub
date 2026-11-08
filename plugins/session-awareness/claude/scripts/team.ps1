# team.sh's Windows twin (experimental, never run on Windows: fix and commit back whatever breaks).
# Print the current digest of a workspace's sessions. Usage: team.ps1 <workspace-id>
# Folder: WORK_HUB_SESSION_AWARENESS_DIR, else <WORK_HUB_STATE_DIR or %USERPROFILE%\.local\state\work-hub>\plugins\session-awareness.
param([Parameter(Position = 0)][string]$Workspace)
$ErrorActionPreference = 'Stop'

if (-not $Workspace) {
  [Console]::Error.WriteLine('usage: team.ps1 <workspace-id>')
  exit 2
}
$state = if ($env:WORK_HUB_STATE_DIR) { $env:WORK_HUB_STATE_DIR } else { Join-Path $env:USERPROFILE '.local\state\work-hub' }
$dir = if ($env:WORK_HUB_SESSION_AWARENESS_DIR) { $env:WORK_HUB_SESSION_AWARENESS_DIR } else { Join-Path $state 'plugins\session-awareness' }
$file = Join-Path (Join-Path $dir 'digests') "$Workspace.md"
if ((Test-Path $file) -and (Get-Item $file).Length -gt 0) {
  Get-Content -Raw $file | Write-Output
} else {
  Write-Output "work-hub: no other sessions recorded for $Workspace"
}
