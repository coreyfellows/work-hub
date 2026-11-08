# Shared by every Windows script that writes, restarts or removes work-hub's background agents
# (scripts\windows\setup-lan.ps1, update.ps1, setup-auth.ps1, restart-agent.ps1, plugins\{notes,code}\setup\install-agent.ps1).
# The Windows twin of scripts/lib/launchd.sh. Dot-source it after setting $Repo (this checkout's absolute path):
#
#   $Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
#   . (Join-Path $PSScriptRoot 'lib\Agents.ps1')
#
# Dot-sourced (not a module) on purpose: a module's functions don't see the caller's $ErrorActionPreference, and these
# helpers rely on 'Stop' like the bash ones rely on `set -e`.
#
# Agents are Scheduled Tasks for the current user, in the task folder \work-hub\, named with the same label as on macOS
# (${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}[-suffix]). Each runs at logon, hidden, with no time limit, restarted on
# failure, and its action runs a generated launcher <state dir>\agents\<label>.cmd that sets the environment, keeps the
# program running (like launchd's KeepAlive) and appends its output to <state dir>\logs\<label>.log.
#
# Ownership: every task these scripts register carries "WORK_HUB_REPO=<checkout>" on a line of its Description, and
# nothing is stopped, replaced, deleted or restarted unless that names this checkout, and every absolute .ts path its
# launcher runs sits under it. -Adopt takes a foreign task over on purpose (same rule as launchd_points_here).
#
# Env: WORK_HUB_LAUNCHD_PREFIX (label prefix), WORK_HUB_STATE_DIR (default $HOME\.local\state\work-hub, like
# server/config.ts: HOME, else the user profile; XDG_STATE_HOME honoured too).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Variable -Name Repo -ErrorAction SilentlyContinue) -or -not $Repo) {
  throw 'scripts\windows\lib\Agents.ps1: set $Repo (the checkout path) before dot-sourcing it'
}

$WhTaskPath = '\work-hub\'

# ---- messages and exits ---------------------------------------------------------------------------------------------

function Write-WhError([string]$Message) { [Console]::Error.WriteLine($Message) }

# Prints to stderr and ends the script with <Code> (exit in a function ends the whole script).
function Stop-WhScript([string]$Message, [int]$Code = 1) {
  Write-WhError $Message
  exit $Code
}

function Assert-WhWindows {
  if ($env:OS -ne 'Windows_NT') { Stop-WhScript 'This script is for Windows; on macOS and Linux use the bash script in scripts/.' 1 }
}

# The first argument that isn't null or empty, as a string ('' when none is).
function Select-WhFirst {
  foreach ($v in $args) { if ($null -ne $v -and [string]$v -ne '') { return [string]$v } }
  return ''
}

# ---- labels and folders ---------------------------------------------------------------------------------------------

# The login name with anything but letters, digits and "-" turned into "-", so first.last gives com.first-last.work-hub.
function Get-WhLabelUser {
  $u = Select-WhFirst $env:USERNAME ([Environment]::UserName)
  return ($u -replace '[^A-Za-z0-9-]', '-')
}

# The label prefix: <Override>, else $env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub.
function Get-WhPrefix([string]$Override = '') {
  $p = Select-WhFirst $Override $env:WORK_HUB_LAUNCHD_PREFIX "com.$(Get-WhLabelUser).work-hub"
  if ($p -notmatch '^[A-Za-z0-9._-]+$') {
    Stop-WhScript "Not a usable label prefix (letters, digits, '.', '_' and '-' only): $p" 2
  }
  return $p
}

function Get-WhHome { return (Select-WhFirst $env:HOME ([Environment]::GetFolderPath('UserProfile'))) }

function Get-WhStateDir {
  if ($env:WORK_HUB_STATE_DIR) { return $env:WORK_HUB_STATE_DIR }
  $base = Select-WhFirst $env:XDG_STATE_HOME (Join-Path (Get-WhHome) '.local\state')
  return (Join-Path $base 'work-hub')
}
function Get-WhConfigDir {
  if ($env:WORK_HUB_CONFIG_DIR) { return $env:WORK_HUB_CONFIG_DIR }
  $base = Select-WhFirst $env:XDG_CONFIG_HOME (Join-Path (Get-WhHome) '.config')
  return (Join-Path $base 'work-hub')
}
function Get-WhCacheDir {
  if ($env:WORK_HUB_CACHE_DIR) { return $env:WORK_HUB_CACHE_DIR }
  $base = Select-WhFirst $env:XDG_CACHE_HOME (Join-Path (Get-WhHome) '.cache')
  return (Join-Path $base 'work-hub')
}
function Get-WhPluginsFile { return (Select-WhFirst $env:WORK_HUB_PLUGINS_FILE (Join-Path (Get-WhConfigDir) 'plugins.json')) }
function Get-WhLogDir { return (Join-Path (Get-WhStateDir) 'logs') }
function Get-WhAgentsDir { return (Join-Path (Get-WhStateDir) 'agents') }
function Get-WhUserId { return [Security.Principal.WindowsIdentity]::GetCurrent().Name }

# ---- tools ----------------------------------------------------------------------------------------------------------

# The full path of the first of <Names> found on PATH (an .exe, or a .cmd shim like pnpm.cmd), else the first existing
# <Fallbacks> file, else ''.
function Find-WhTool([string[]]$Names, [string[]]$Fallbacks = @()) {
  foreach ($n in $Names) {
    $c = Get-Command -Name $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.Path }
  }
  foreach ($f in $Fallbacks) { if ($f -and (Test-Path -LiteralPath $f -PathType Leaf)) { return $f } }
  return ''
}

# Runs a native program, its output on the pipeline, and ends the script if it exits non-zero (PowerShell doesn't stop
# on a native command's exit code by itself).
function Invoke-WhChecked([string]$File, [string[]]$Arguments = @(), [string]$What = '') {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { Stop-WhScript "$(Select-WhFirst $What $File) failed (exit $LASTEXITCODE)" 1 }
}

# Runs a native program with stderr dropped and returns { ExitCode; Output }. Under 'Stop', PowerShell 5.1 turns a
# redirected stderr line into a terminating error, so the preference is relaxed in here only.
function Invoke-WhQuiet([string]$File, [string[]]$Arguments = @()) {
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $File @Arguments 2>$null
    $code = $LASTEXITCODE
  } catch {
    return [pscustomobject]@{ ExitCode = -1; Output = @() }
  }
  return [pscustomobject]@{ ExitCode = $code; Output = @($out | ForEach-Object { [string]$_ }) }
}

# A native program's trimmed stdout; ends the script if it fails.
function Invoke-WhOutput([string]$File, [string[]]$Arguments = @()) {
  $r = Invoke-WhQuiet $File $Arguments
  if ($r.ExitCode -ne 0) { Stop-WhScript "$File $($Arguments -join ' ') failed (exit $($r.ExitCode))" 1 }
  return (($r.Output -join "`n").Trim())
}

# ---- files ----------------------------------------------------------------------------------------------------------

# UTF-8 without a BOM (PowerShell 5.1's -Encoding UTF8 adds one, which breaks the first line of a .cmd file).
function Write-WhUtf8File([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

# The Windows "chmod 600 / 700": inheritance removed, full control for the current user only.
function Protect-WhPath([string]$Path, [switch]$Directory) {
  $me = Get-WhUserId
  $grant = if ($Directory) { "${me}:(OI)(CI)F" } else { "${me}:F" }
  $r = Invoke-WhQuiet 'icacls.exe' @($Path, '/inheritance:r', '/grant:r', $grant)
  if ($r.ExitCode -ne 0) { Stop-WhScript "Couldn't restrict $Path to $me (icacls exit $($r.ExitCode))" 1 }
}

# <Bytes> random bytes as base64url (like the server's tokens) or hex.
function New-WhRandomToken([int]$Bytes, [string]$Format = 'base64url') {
  $b = New-Object byte[] $Bytes
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  if ($Format -eq 'hex') { return (($b | ForEach-Object { $_.ToString('x2') }) -join '') }
  return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# A path made absolute, one level of symlink/junction resolved, no trailing "\".
function Get-WhFullPath([string]$Path) {
  $p = [IO.Path]::GetFullPath($Path)
  try {
    $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop
    $lt = $item.PSObject.Properties['LinkType']
    if ($lt -and $lt.Value) {
      $t = @($item.Target)[0]
      if ($t) {
        if (-not [IO.Path]::IsPathRooted($t)) { $t = Join-Path (Split-Path -Parent $p) $t }
        $p = [IO.Path]::GetFullPath($t)
      }
    }
  } catch { }
  return $p.TrimEnd('\')
}
function Test-WhSamePath([string]$A, [string]$B) {
  return [string]::Equals((Get-WhFullPath $A), (Get-WhFullPath $B), [StringComparison]::OrdinalIgnoreCase)
}
function Test-WhPathUnder([string]$Child, [string]$Parent) {
  return (Get-WhFullPath $Child).StartsWith((Get-WhFullPath $Parent) + '\', [StringComparison]::OrdinalIgnoreCase)
}
# A drive-absolute (C:\...) or UNC (\\server\...) path, the Windows "starts with /".
function Test-WhAbsolutePath([string]$Path) { return ($Path -match '^([A-Za-z]:[\\/]|\\\\)') }

# ---- plugins.json ---------------------------------------------------------------------------------------------------

# plugins.json parsed, or $null when it's missing or empty; ends the script (exit 3) when it can't be parsed.
function Read-WhPluginsConfig([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $null }
  try {
    $text = [IO.File]::ReadAllText($File)
    if (-not $text.Trim()) { return $null }
    return ($text | ConvertFrom-Json)
  } catch {
    Stop-WhScript "can not read ${File}: $($_.Exception.Message)" 3
  }
}

# A value at <Path> (property names) in parsed JSON, or $null (safe under StrictMode, which throws on missing properties).
function Get-WhJsonValue($Object, [string[]]$Path) {
  $cur = $Object
  foreach ($k in $Path) {
    if ($null -eq $cur) { return $null }
    $p = $cur.PSObject.Properties[$k]
    if (-not $p) { return $null }
    $cur = $p.Value
  }
  return $cur
}

# settings[<Id>][<Key>] as a string like JS String(v) ('' when unset; true/false lower case).
function Get-WhPluginSetting($Config, [string]$Id, [string]$Key) {
  $v = Get-WhJsonValue $Config @('settings', $Id, $Key)
  if ($null -eq $v) { return '' }
  if ($v -is [bool]) { return $v.ToString().ToLowerInvariant() }
  return (([string]$v) -replace "`r?`n", ' ')
}

# Whether a plugin is on: plugins.json enabled[<Id>] when it's a boolean, else its manifest's defaultEnabled.
function Test-WhPluginOn($Config, [string]$Id) {
  $v = Get-WhJsonValue $Config @('enabled', $Id)
  if ($v -is [bool]) { return $v }
  try {
    $m = [IO.File]::ReadAllText((Join-Path $Repo "plugins\$Id\plugin.json")) | ConvertFrom-Json
    return [bool](Get-WhJsonValue $m @('defaultEnabled'))
  } catch { return $false }
}

# The VS Code CLI that has serve-web: the per-user install's code-tunnel.exe, else the system install's, else
# code-tunnel or code on PATH; the per-user path when none is found (so the "missing" message names it).
function Get-WhDefaultVsCodeCli {
  $candidates = @()
  if ($env:LOCALAPPDATA) { $candidates += "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code-tunnel.exe" }
  if ($env:ProgramFiles) { $candidates += "$env:ProgramFiles\Microsoft VS Code\bin\code-tunnel.exe" }
  foreach ($c in $candidates) { if (Test-Path -LiteralPath $c -PathType Leaf) { return $c } }
  $found = Find-WhTool @('code-tunnel', 'code')
  if ($found) { return $found }
  return (Select-WhFirst (@($candidates)[0]) 'code-tunnel.exe')
}

# ---- Scheduled Tasks: lookup and ownership ---------------------------------------------------------------------------

function Test-WhTaskSupport { return [bool](Get-Command -Name Get-ScheduledTask -ErrorAction SilentlyContinue) }

function Get-WhAgentTask([string]$Label) {
  try { return (Get-ScheduledTask -TaskPath $WhTaskPath -TaskName $Label -ErrorAction Stop) } catch { return $null }
}

# The checkout a task points at: the WORK_HUB_REPO=<path> line of its Description; '' when it names none.
function Get-WhTaskRepo($Task) {
  foreach ($line in (([string]$Task.Description) -split "`r?`n")) {
    if ($line -match '^\s*WORK_HUB_REPO=(.+?)\s*$') { return $Matches[1] }
  }
  return ''
}

# The launcher (.cmd) a task's action runs; '' when it runs none.
function Get-WhTaskLauncher($Task) {
  foreach ($a in @($Task.Actions)) {
    $p = $a.PSObject.Properties['Arguments']
    if ($p -and ([string]$p.Value) -match '([A-Za-z]:\\[^"]+?\.cmd)') { return $Matches[1] }
  }
  return ''
}

# Why <Label>'s task isn't this checkout's to touch; '' when it is, or when there's no such task.
function Get-WhForeignReason([string]$Label) {
  $task = Get-WhAgentTask $Label
  if (-not $task) { return '' }
  $where = "Scheduled Task $WhTaskPath$Label"
  $owner = Get-WhTaskRepo $task
  if (-not $owner) { return "$where names no checkout (no WORK_HUB_REPO in its Description)" }
  if (-not (Test-WhSamePath $owner $Repo)) { return "$where points at $owner, not this checkout ($Repo)" }
  $launcher = Get-WhTaskLauncher $task
  if ($launcher -and (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    $text = [IO.File]::ReadAllText($launcher)
    foreach ($m in [regex]::Matches($text, '"([A-Za-z]:\\[^"]*\.ts)"')) {
      $ts = $m.Groups[1].Value.Replace('%%', '%')
      if (-not (Test-WhPathUnder $ts $Repo)) { return "$where runs $ts, outside this checkout ($Repo)" }
    }
  }
  return ''
}

# True when <Label> has a task and it points at this checkout (what update.ps1 restarts).
function Test-WhPointsHere([string]$Label) {
  if (-not (Get-WhAgentTask $Label)) { return $false }
  return (-not (Get-WhForeignReason $Label))
}

# Checks each label before acting on it. Mode 'apply': prints why to stderr and returns $false if any is foreign;
# anything else (a dry run): prints a warning and returns $true. With -Adopt foreign tasks are taken over (noted).
function Test-WhOwned([string]$Mode, [string[]]$Labels, [bool]$Adopt = $false) {
  $ok = $true
  foreach ($label in $Labels) {
    $reason = Get-WhForeignReason $label
    if (-not $reason) { continue }
    if ($Adopt) {
      Write-Host "Adopting $label (-Adopt): $reason"
    } elseif ($Mode -eq 'apply') {
      Write-WhError "Refusing to touch ${label}: $reason. Run it from that checkout, or pass -Adopt to take it over."
      $ok = $false
    } else {
      Write-Host "  warning: -Apply would refuse ${label}: $reason (pass -Adopt to take it over)"
    }
  }
  return $ok
}

# Every task in \work-hub\ named <Prefix> or <Prefix>-<something>, sorted.
function Get-WhInstalledLabels([string]$Prefix) {
  if (-not (Test-WhTaskSupport)) { return @() }
  try { $tasks = @(Get-ScheduledTask -TaskPath $WhTaskPath -ErrorAction Stop) } catch { return @() }
  return @($tasks | Where-Object { $_.TaskName -eq $Prefix -or $_.TaskName.StartsWith("$Prefix-") } |
    ForEach-Object { $_.TaskName } | Sort-Object -Unique)
}

function Test-WhAgentRunning([string]$Label) {
  $t = Get-WhAgentTask $Label
  return [bool]($t -and [string]$t.State -eq 'Running')
}

# Something listens on TCP <Port> (any address).
function Test-WhListening([int]$Port) {
  return (@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0)
}

# ---- launchers ------------------------------------------------------------------------------------------------------

# A value made safe inside "..." in a .cmd file: % doubled; a double quote or line break can't be carried, so it's refused.
function ConvertTo-WhCmdText([string]$Value, [string]$What) {
  if ($Value -match "[`"`r`n]") { Stop-WhScript "Can't put $What in a .cmd launcher (it has a double quote or a line break): $Value" 2 }
  return $Value.Replace('%', '%%')
}

function Get-WhLauncherPath([string]$Label) { return (Join-Path (Get-WhAgentsDir) "$Label.cmd") }
function Get-WhAgentLog([string]$Label) { return (Join-Path (Get-WhLogDir) "$Label.log") }

# The .cmd launcher a task runs: sets WORK_HUB_REPO and <Environment> (an ordered hashtable), puts <PathPrepend> in
# front of PATH, cds to <WorkingDirectory>, then runs <Program> <Arguments> with stdout and stderr appended to the log,
# again 5 seconds after it exits (launchd's KeepAlive). Task Scheduler's own restart-on-failure only covers the launcher.
function New-WhLauncherText([string]$Label, [string]$Program, [string[]]$Arguments = @(), $Environment = $null,
  [string[]]$PathPrepend = @(), [string]$WorkingDirectory = '') {
  $log = ConvertTo-WhCmdText (Get-WhAgentLog $Label) 'the log file'
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add('@echo off')
  $lines.Add('rem A work-hub background agent, written by scripts\windows\lib\Agents.ps1 on every install: change the script, not this file.')
  $lines.Add('chcp 65001 >nul')
  $lines.Add('set "WORK_HUB_REPO=' + (ConvertTo-WhCmdText $Repo 'the checkout path') + '"')
  if ($null -ne $Environment) {
    foreach ($k in $Environment.Keys) {
      if ($k -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { Stop-WhScript "Not an environment variable name: $k" 2 }
      $lines.Add('set "' + $k + '=' + (ConvertTo-WhCmdText ([string]$Environment[$k]) $k) + '"')
    }
  }
  $dirs = @($PathPrepend | Where-Object { $_ } | ForEach-Object { ConvertTo-WhCmdText $_ 'a PATH entry' })
  if ($dirs.Count -gt 0) { $lines.Add('set "PATH=' + ($dirs -join ';') + ';%PATH%"') }
  if ($WorkingDirectory) { $lines.Add('cd /d "' + (ConvertTo-WhCmdText $WorkingDirectory 'the working directory') + '"') }
  # A .cmd/.bat program (e.g. code.cmd) needs `call`, which expands % a second time: refuse % there rather than mangle it.
  $prefix = ''
  if ($Program -match '\.(cmd|bat)$') {
    $prefix = 'call '
    foreach ($v in @($Program) + @($Arguments)) { if ($v.Contains('%')) { Stop-WhScript "Can't pass a value with % to a .cmd program: $v" 2 } }
  }
  $cmd = $prefix + '"' + (ConvertTo-WhCmdText $Program 'the program') + '"'
  foreach ($a in $Arguments) { $cmd += ' "' + (ConvertTo-WhCmdText $a 'an argument') + '"' }
  $lines.Add(':run')
  $lines.Add('echo [%DATE% %TIME%] starting ' + $Label + '>>"' + $log + '"')
  $lines.Add($cmd + ' >>"' + $log + '" 2>&1')
  $lines.Add('echo [%DATE% %TIME%] ' + $Label + ' exited with code %ERRORLEVEL%, restarting in 5s>>"' + $log + '"')
  $lines.Add('ping -n 6 127.0.0.1 >nul')
  $lines.Add('goto run')
  return (($lines -join "`r`n") + "`r`n")
}

# ---- Scheduled Tasks: install, stop, start, remove ------------------------------------------------------------------

# Processes started for a launcher (conhost and cmd name its path) and all their descendants, parents first.
function Get-WhAgentProcesses([string]$Launcher) {
  $all = @(Get-CimInstance -ClassName Win32_Process)
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($p in $all) {
    if ($p.CommandLine -and $p.CommandLine.IndexOf($Launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
      if ($seen.Add([int]$p.ProcessId)) { $out.Add($p) }
    }
  }
  for ($i = 0; $i -lt $out.Count; $i++) {
    $parent = $out[$i]
    foreach ($c in $all) {
      # A child is younger than its parent; an older process with that parent id is a reused pid.
      if ($c.ParentProcessId -eq $parent.ProcessId -and $c.CreationDate -ge $parent.CreationDate) {
        if ($seen.Add([int]$c.ProcessId)) { $out.Add($c) }
      }
    }
  }
  return $out.ToArray()
}

# Stops <Label>'s task and whatever its launcher started. Stop-ScheduledTask ends the task's own process, but a child
# can outlive it, so the launcher's process tree is collected first and ended by pid (checked against its start time,
# so a reused pid is never hit) — never by a name or command-line pattern.
function Stop-WhAgent([string]$Label) {
  $task = Get-WhAgentTask $Label
  if (-not $task) { return }
  $launcher = Select-WhFirst (Get-WhTaskLauncher $task) (Get-WhLauncherPath $Label)
  $tree = @(Get-WhAgentProcesses $launcher)
  try { Stop-ScheduledTask -TaskPath $WhTaskPath -TaskName $Label -ErrorAction Stop } catch { }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Test-WhAgentRunning $Label)) { break }
    Start-Sleep -Milliseconds 250
  }
  foreach ($p in $tree) {
    $now = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($p.ProcessId)" -ErrorAction SilentlyContinue
    if ($now -and $now.CreationDate -eq $p.CreationDate) {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-WhAgent([string]$Label) { Start-ScheduledTask -TaskPath $WhTaskPath -TaskName $Label }

function Restart-WhAgent([string]$Label) {
  Stop-WhAgent $Label
  Start-WhAgent $Label
}

# Writes <Label>'s launcher, (re)registers its task and starts it. Check ownership first (Test-WhOwned).
function Install-WhAgent([string]$Label, [string]$LauncherText, [string]$WorkingDirectory) {
  New-Item -ItemType Directory -Force -Path (Get-WhAgentsDir), (Get-WhLogDir) | Out-Null
  $launcher = Get-WhLauncherPath $Label
  Stop-WhAgent $Label
  Write-WhUtf8File $launcher $LauncherText
  $me = Get-WhUserId
  # Hidden: `conhost.exe --headless` runs cmd with no console window at all. `powershell -WindowStyle Hidden` would
  # flash a window at every start and load PowerShell just to run a .cmd; a "run whether logged on or not" task would
  # need a stored password or admin rights.
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') `
    -Argument ('--headless cmd.exe /d /s /c ""' + $launcher + '""') -WorkingDirectory $WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
  $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
  # No time limit (PT0S), restart on failure, start a missed run when possible, keep running on battery, normal
  # priority (a task's default, 7, is below normal for CPU and I/O).
  $settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -MultipleInstances IgnoreNew -Priority 5
  $desc = "work-hub background agent $Label, written by scripts\windows. The line below marks which checkout owns it." +
    "`r`nWORK_HUB_REPO=$Repo"
  Register-ScheduledTask -TaskPath $WhTaskPath -TaskName $Label -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description $desc -Force | Out-Null
  Start-WhAgent $Label
}

# Stops and unregisters <Label>'s task and deletes its launcher. Check ownership first (Test-WhOwned).
function Remove-WhAgent([string]$Label) {
  if (-not (Get-WhAgentTask $Label)) { return }
  Stop-WhAgent $Label
  Unregister-ScheduledTask -TaskPath $WhTaskPath -TaskName $Label -Confirm:$false
  $launcher = Get-WhLauncherPath $Label
  if (Test-Path -LiteralPath $launcher) { Remove-Item -LiteralPath $launcher -Force }
}

# What Install-WhAgent would register, for dry runs.
function Show-WhAgentPlan([string]$Label, [string]$LauncherText) {
  Write-Host "  Scheduled Task $WhTaskPath$Label (at logon, $(Get-WhUserId), hidden, no time limit, restarted on failure)"
  Write-Host "    runs: conhost.exe --headless cmd.exe /d /s /c `"$(Get-WhLauncherPath $Label)`""
  Write-Host "    log:  $(Get-WhAgentLog $Label)"
  Write-Host "    launcher:"
  foreach ($line in ($LauncherText -split "`r`n")) { if ($line) { Write-Host "      $line" } }
}
