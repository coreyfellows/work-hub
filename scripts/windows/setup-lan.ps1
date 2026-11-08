<#
.SYNOPSIS
LAN access for work-hub (Windows): serve the app at https://<hostname> to other devices, behind the auth plugin's
sign-in. The Windows twin of scripts/setup-lan.sh.

.DESCRIPTION
Installs Scheduled Tasks (folder \work-hub\, at logon, hidden; scripts\windows\lib\Agents.ps1), named
$env:WORK_HUB_LAUNCHD_PREFIX, else com.<user>.work-hub:
  <prefix>        the node server on 127.0.0.1:$WORK_HUB_PORT (loopback only), with WORK_HUB_HOSTNAME set
  <prefix>-tls    Caddy serving https://<hostname> (port $WORK_HUB_PUBLIC_PORT, default 443) on the LAN, proxying to node
  <prefix>-notes  SilverBullet under /notes, only if the notes plugin is on (loopback only)
  <prefix>-code   VS Code serve-web under /code, only if the code plugin is on (loopback only, connection token)
  <prefix>-term   the terminals plugin's daemon, only with -WithTerm, and only if that plugin is on with
                  settings.terminals.autostart = false (replacing it ends every shell, so it's never touched otherwise).
                  On Windows it listens on the named pipe \\.\pipe\work-hub-termd-<user> (its default), so there is no
                  socket file to clean up.
/notes and /code are served on the same origin only to requests work-hub says are signed in (Caddy forward_auth ->
/auth-check). The certificate is issued by mkcert's local CA into <state>\tls (renewed when missing, wrong or within 30
days of expiry), so devices that trust "$(mkcert -CAROOT)\rootCA.pem" trust the site (scripts\windows\trust-ca.ps1,
scripts\windows\share-ca.ps1). Node itself still binds 127.0.0.1 only; Caddy is the only thing on the LAN, and the
first time it listens Windows Firewall asks whether to allow it (or use the New-NetFirewallRule line the dry run
prints, from an elevated PowerShell).

LAN access needs the auth plugin's sign-in (the server refuses to start with a hostname and no sign-in): if it's off in
plugins.json, -Apply turns it on ({"enabled": {"auth": true}}, the rest of the file kept). Once everything answers,
-Apply runs scripts\windows\setup-auth.ps1 -Apply, which creates the sign-in token if needed and copies the one-tap
sign-in link to the clipboard (never printed); -NoLink skips that.

Only the tasks this run manages are written or replaced; an installed task for a plugin that is off now is left alone
(remove it with that plugin's setup\install-agent.ps1 -Uninstall, or -Uninstall here). Every task is stamped with this
checkout (WORK_HUB_REPO in its Description), and one that points at another checkout is never replaced, stopped or
removed unless -Adopt is given.

Dry run by default: prints what it would install. Env: WORK_HUB_STATE_DIR, WORK_HUB_CONFIG_DIR, WORK_HUB_CACHE_DIR,
WORK_HUB_PLUGINS_FILE, WORK_HUB_PORT (4848), WORK_HUB_PUBLIC_PORT (443), WORK_HUB_LAUNCHD_PREFIX, WORK_HUB_CADDY,
WORK_HUB_MKCERT. Plugin settings read from plugins.json: notes.{notesDir,localPort,silverbullet,url},
code.{localPort,cli,vscodeTokenFile,url}, terminals.autostart.

.PARAMETER Hostname
A name your devices resolve to this PC (else $env:WORK_HUB_HOSTNAME).

.PARAMETER Apply
Install (without it: a dry run).

.PARAMETER Uninstall
Remove this checkout's tasks (-term only with -WithTerm).

.PARAMETER WithTerm
Also manage <prefix>-term (see above).

.PARAMETER Adopt
Take over tasks that point at another checkout (e.g. after moving the repo).

.PARAMETER NoLink
Don't copy the sign-in link at the end.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-lan.ps1 -Hostname hub.example.lan -Apply
#>
param(
  [string]$Hostname = $env:WORK_HUB_HOSTNAME,
  [switch]$Apply,
  [switch]$Uninstall,
  [switch]$WithTerm,
  [switch]$Adopt,
  [switch]$NoLink
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows

if ($Apply -and $Uninstall) { Stop-WhScript 'Pass -Apply or -Uninstall, not both.' 2 }
$mode = 'dry-run'
if ($Apply) { $mode = 'apply' }
if ($Uninstall) { $mode = 'uninstall' }
if (-not (Test-WhTaskSupport)) { Stop-WhScript 'The ScheduledTasks PowerShell module is missing (Windows 8 / Server 2012 or later has it).' 1 }

$prefix = Get-WhPrefix
$labels = @($prefix, "$prefix-tls", "$prefix-notes", "$prefix-code")
if ($WithTerm) { $labels += "$prefix-term" }
$state = Get-WhStateDir
$config = Get-WhConfigDir
$cache = Get-WhCacheDir
$pluginsFile = Get-WhPluginsFile
$logDir = Get-WhLogDir
$apiPort = Select-WhFirst $env:WORK_HUB_PORT '4848'
$publicPort = Select-WhFirst $env:WORK_HUB_PUBLIC_PORT '443'
$userHome = Get-WhHome

if ($mode -eq 'uninstall') {
  if (-not (Test-WhOwned 'apply' $labels ([bool]$Adopt))) { exit 1 }
  if (-not $WithTerm -and (Get-WhAgentTask "$prefix-term")) {
    Write-Host "Left $prefix-term alone (it ends every shell): add -WithTerm to remove it too."
  }
  foreach ($label in $labels) {
    if (-not (Get-WhAgentTask $label)) { continue }
    Remove-WhAgent $label
    Write-Host "Removed $label"
  }
  exit 0
}

if (-not $Hostname) { Stop-WhScript 'A hostname is required: -Hostname <name> or WORK_HUB_HOSTNAME (a name your devices resolve to this PC)' 2 }
if ($Hostname -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { Stop-WhScript "Not a hostname: $Hostname" 2 }
if ($apiPort -notmatch '^[0-9]+$') { Stop-WhScript "WORK_HUB_PORT is not a port: $apiPort" 2 }
if ($publicPort -notmatch '^[0-9]+$') { Stop-WhScript "WORK_HUB_PUBLIC_PORT is not a port: $publicPort" 2 }
$node = Find-WhTool @('node')
if (-not $node) { Stop-WhScript 'node not found on PATH (winget install OpenJS.NodeJS; work-hub needs Node 26)' 1 }

# Which plugins are on (plugins.json "enabled", else each manifest's defaultEnabled) and their settings.
$cfg = Read-WhPluginsConfig $pluginsFile
$authOn = Test-WhPluginOn $cfg 'auth'
$notesOn = Test-WhPluginOn $cfg 'notes'
$codeOn = Test-WhPluginOn $cfg 'code'
$termOn = Test-WhPluginOn $cfg 'terminals'

$notesDir = Select-WhFirst (Get-WhPluginSetting $cfg 'notes' 'notesDir') $env:TW_NOTES_DIR (Join-Path $userHome 'notes')
$notesLocalPort = Select-WhFirst (Get-WhPluginSetting $cfg 'notes' 'localPort') '18744'
$notesUrl = Select-WhFirst (Get-WhPluginSetting $cfg 'notes' 'url') '/notes'
$silverbullet = Select-WhFirst (Get-WhPluginSetting $cfg 'notes' 'silverbullet') $env:TW_SILVERBULLET_BIN `
  (Find-WhTool @('silverbullet')) (Join-Path $userHome '.local\bin\silverbullet.exe')
$codeLocalPort = Select-WhFirst (Get-WhPluginSetting $cfg 'code' 'localPort') '18743'
$codeUrl = Select-WhFirst (Get-WhPluginSetting $cfg 'code' 'url') '/code'
$vscodeCli = Select-WhFirst (Get-WhPluginSetting $cfg 'code' 'cli') $env:TW_VSCODE_CLI (Get-WhDefaultVsCodeCli)
$vscodeTokenFile = Select-WhFirst (Get-WhPluginSetting $cfg 'code' 'vscodeTokenFile') $env:TW_VSCODE_TOKEN_FILE `
  (Join-Path $userHome '.local\state\vscode-serve-web.token')
$wantTerm = $WithTerm -and $termOn -and ((Get-WhPluginSetting $cfg 'terminals' 'autostart') -eq 'false')

# Turns the auth plugin on in plugins.json (created if missing; everything else in it kept). Node rewrites it so the
# file keeps its shape (PowerShell 5.1's ConvertTo-Json reformats and can flatten arrays). The JS has no double quotes:
# PowerShell 5.1 doesn't escape them when passing an argument to a native program.
function Enable-Auth {
  $js = "const fs = require('fs'), path = require('path'); const file = process.argv[1]; let cfg = {};" +
    " try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }" +
    " cfg.enabled = { ...(cfg.enabled ?? {}), auth: true }; fs.mkdirSync(path.dirname(file), { recursive: true });" +
    " fs.writeFileSync(file + '.tmp', JSON.stringify(cfg, null, 2) + '\n'); fs.renameSync(file + '.tmp', file);"
  Invoke-WhChecked $node @('-e', $js, $pluginsFile) 'turning on the auth plugin in plugins.json'
}

$cert = Join-Path $state "tls\$Hostname.pem"
$key = Join-Path $state "tls\$Hostname-key.pem"
$mkcert = Select-WhFirst $env:WORK_HUB_MKCERT (Find-WhTool @('mkcert'))
$caddy = Select-WhFirst $env:WORK_HUB_CADDY (Find-WhTool @('caddy'))
$pnpm = Find-WhTool @('pnpm')
$gh = Find-WhTool @('gh')
$git = Find-WhTool @('git')
if ($publicPort -eq '443') { $site = "https://$Hostname" } else { $site = "https://${Hostname}:$publicPort" }

function Test-Exe([string]$Path) { return ($Path -and (Test-Path -LiteralPath $Path -PathType Leaf)) }
$missing = @()
if (-not (Test-Exe $caddy)) { $missing += 'Caddy (winget install CaddyServer.Caddy; or WORK_HUB_CADDY)' }
if (-not (Test-Exe $mkcert)) { $missing += 'mkcert (winget install FiloSottile.mkcert; then mkcert -install; or WORK_HUB_MKCERT)' }
if (-not $pnpm) { $missing += 'pnpm (npm install -g pnpm, or corepack enable)' }
if ($notesOn -and -not (Test-Exe $silverbullet)) { $missing += "SilverBullet at $silverbullet (settings.notes.silverbullet)" }
if ($codeOn) {
  if (-not (Test-Exe $vscodeCli)) { $missing += "VS Code CLI at $vscodeCli (settings.code.cli)" }
  if (-not (Test-Path -LiteralPath $vscodeTokenFile -PathType Leaf) -or (Get-Item -LiteralPath $vscodeTokenFile).Length -eq 0) {
    $missing += "VS Code connection token file $vscodeTokenFile (settings.code.vscodeTokenFile)"
  }
}
if ($missing.Count -gt 0 -and $mode -eq 'apply') {
  foreach ($m in $missing) { Write-WhError "Missing: $m" }
  exit 1
}

# The certificate is there, names the hostname and doesn't expire within 30 days (no openssl on Windows: .NET reads it).
function Test-CertOk {
  foreach ($f in @($cert, $key)) {
    if (-not (Test-Path -LiteralPath $f -PathType Leaf) -or (Get-Item -LiteralPath $f).Length -eq 0) { return $false }
  }
  try {
    $m = [regex]::Match([IO.File]::ReadAllText($cert), '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----')
    if (-not $m.Success) { return $false }
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s', '')))
    if ($c.NotAfter -lt (Get-Date).AddDays(30)) { return $false }
    $san = $c.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | Select-Object -First 1
    if (-not $san) { return $false }
    # Format() reads like "DNS Name=host, DNS Name=other" (the label can be localised, so only "=host" is matched).
    return ($san.Format($false) -match ('(^|[,\s=])' + [regex]::Escape($Hostname) + '(,|\s|$)'))
  } catch { return $false }
}

# Scheduled Tasks get the user's own environment; still put node's, gh's and git's folders first, as on macOS.
$pathDirs = @((Split-Path -Parent $node))
if ($gh) { $pathDirs += (Split-Path -Parent $gh) }
if ($git) { $pathDirs += (Split-Path -Parent $git) }
$pathDirs += (Join-Path $userHome '.local\bin')
$pathDirs = @($pathDirs | Select-Object -Unique)

$toolsBlock = ''
if ($notesOn -or $codeOn) {
  $match = ''
  $routes = ''
  if ($notesOn) {
    $match += " $notesUrl $notesUrl/*"
    $routes += "`n`t`thandle $notesUrl* {`n`t`t`treverse_proxy 127.0.0.1:$notesLocalPort`n`t`t}"
  }
  if ($codeOn) {
    $match += " $codeUrl $codeUrl/*"
    $routes += "`n`t`thandle $codeUrl* {`n`t`t`treverse_proxy 127.0.0.1:$codeLocalPort`n`t`t}"
  }
  $toolsBlock = "`n`t# Notes and VS Code: only for requests work-hub says are signed in (else it redirects to /login).`n" +
    "`t@tools path$match`n" +
    "`thandle @tools {`n`t`tforward_auth 127.0.0.1:$apiPort {`n`t`t`turi /auth-check`n`t`t}$routes`n`t}`n"
}

# Forward slashes in the Caddyfile: Go takes them on Windows, and they need no escaping.
$certFwd = $cert.Replace('\', '/')
$keyFwd = $key.Replace('\', '/')
$caddyfileBody = "{`n`tadmin off`n`tauto_https off`n}`n$site {`n`ttls `"$certFwd`" `"$keyFwd`"`n`n" +
  "`t# Compress responses (the SSE stream and the app bundle are text). Caddy flushes event streams as they come.`n" +
  "`tencode zstd gzip`n$toolsBlock`n`thandle {`n`t`treverse_proxy 127.0.0.1:$apiPort`n`t}`n}"
$caddyfile = Join-Path $state 'Caddyfile'

$commonEnv = [ordered]@{ WORK_HUB_STATE_DIR = $state; WORK_HUB_CONFIG_DIR = $config; WORK_HUB_CACHE_DIR = $cache }
function Merge-Env($First) {
  $h = [ordered]@{}
  foreach ($k in $First.Keys) { $h[$k] = $First[$k] }
  foreach ($k in $commonEnv.Keys) { $h[$k] = $commonEnv[$k] }
  return $h
}

# One launcher per task (what the plist is on macOS).
function Get-Launcher([string]$Label) {
  switch ($Label) {
    $prefix {
      return (New-WhLauncherText $Label $node @("$Repo\server\index.ts") `
        (Merge-Env ([ordered]@{ NODE_ENV = 'production'; WORK_HUB_HOSTNAME = $Hostname; WORK_HUB_PORT = $apiPort; WORK_HUB_PUBLIC_PORT = $publicPort })) `
        $pathDirs $Repo)
    }
    "$prefix-tls" {
      return (New-WhLauncherText $Label $caddy @('run', '--config', $caddyfile, '--adapter', 'caddyfile') $null @() $Repo)
    }
    # SilverBullet on the notes folder under /notes, without its own login: work-hub's sign-in gates it, loopback only.
    "$prefix-notes" {
      return (New-WhLauncherText $Label $silverbullet @('--single', '-L', '127.0.0.1', '-p', $notesLocalPort, $notesDir) `
        ([ordered]@{ SB_URL_PREFIX = $notesUrl; SB_SHELL_BACKEND = 'off' }) @() $Repo)
    }
    # VS Code serve-web under /code, keeping its connection token (work-hub hands it only to signed-in users).
    "$prefix-code" {
      return (New-WhLauncherText $Label $vscodeCli @('serve-web', '--accept-server-license-terms', '--host', '127.0.0.1',
          '--port', $codeLocalPort, '--server-base-path', $codeUrl, '--connection-token-file', $vscodeTokenFile) $null @() $Repo)
    }
    # The terminals plugin's daemon; its shells outlive restarts of the main server. It writes its own log beside the
    # task's (two writers on one file can trip over Windows file locks).
    "$prefix-term" {
      return (New-WhLauncherText $Label $node @("$Repo\plugins\terminals\termd.ts") `
        (Merge-Env ([ordered]@{ LANG = 'en_US.UTF-8'; WORK_HUB_TERMD_LOG = (Join-Path $logDir "$prefix-term-daemon.log") })) `
        $pathDirs $Repo)
    }
  }
  throw "no launcher for $Label"
}

$want = @($prefix, "$prefix-tls")
if ($notesOn) { $want += "$prefix-notes" }
if ($codeOn) { $want += "$prefix-code" }
if ($wantTerm) { $want += "$prefix-term" }

# Installed tasks this run doesn't manage (their plugin is off, or -term without -WithTerm): never touched here.
function Show-Unmanaged {
  foreach ($label in @("$prefix-notes", "$prefix-code", "$prefix-term")) {
    if ($want -contains $label -or -not (Get-WhAgentTask $label)) { continue }
    if ($label -eq "$prefix-term" -and -not $WithTerm) {
      Write-Host "  $label is installed and left alone (pass -WithTerm to manage it; replacing it ends every shell)"
    } else {
      Write-Host "  $label is installed but not managed this run (its plugin is off or doesn't need it); left alone"
    }
  }
}

$firewallHint = "New-NetFirewallRule -DisplayName 'work-hub Caddy ($publicPort)' -Direction Inbound -Protocol TCP " +
  "-LocalPort $publicPort -Program '$caddy' -Action Allow -Profile Private"

if ($mode -eq 'dry-run') {
  Write-Host "Dry run. With -Apply this would build the UI, then register in Task Scheduler ($WhTaskPath):"
  Write-Host "  $prefix         node on 127.0.0.1:$apiPort (WORK_HUB_HOSTNAME=$Hostname, state $state)"
  Write-Host "  $prefix-tls     Caddy on $site"
  if ($notesOn) { Write-Host "  $prefix-notes   SilverBullet on 127.0.0.1:$notesLocalPort ($notesDir), served at $site$notesUrl" }
  if ($codeOn) { Write-Host "  $prefix-code    VS Code serve-web on 127.0.0.1:$codeLocalPort, served at $site$codeUrl" }
  if ($wantTerm) { Write-Host "  $prefix-term    terminal daemon on \\.\pipe\work-hub-termd-<user> (terminals.autostart is false)" }
  if (-not $authOn) { Write-Host "  would turn on the auth plugin (sign-in) in $($pluginsFile): it's off, and LAN access needs it" }
  if (Test-CertOk) { Write-Host "  certificate $cert is valid" } else { Write-Host "  would issue a certificate for $Hostname at $cert (mkcert)" }
  foreach ($m in $missing) { Write-Host "  missing (needed for -Apply): $m" }
  [void](Test-WhOwned 'dry-run' $want ([bool]$Adopt))
  Show-Unmanaged
  if ($missing.Count -eq 0) {
    foreach ($label in $want) { Show-WhAgentPlan $label (Get-Launcher $label) }
  }
  Write-Host "  $($caddyfile):"
  foreach ($line in ($caddyfileBody -split "`n")) { Write-Host "    $line" }
  Write-Host "  Windows Firewall asks the first time Caddy listens on port $publicPort; to allow it up front (Private"
  Write-Host '  networks only), run this once from an elevated PowerShell (not run by this script):'
  Write-Host "    $firewallHint"
  if (-not $NoLink) { Write-Host "  would then copy the sign-in link for $site to the clipboard (scripts\windows\setup-auth.ps1 -Apply)" }
  Write-Host 'Re-run with -Apply to install.'
  exit 0
}

if (-not (Test-WhOwned 'apply' $want ([bool]$Adopt))) { exit 1 }
if (-not $authOn) {
  Enable-Auth
  Write-Host "Turned on the auth plugin (sign-in) in $pluginsFile"
}
Push-Location -LiteralPath $Repo
try { Invoke-WhChecked $pnpm @('build') 'pnpm build' | Out-Null } finally { Pop-Location }
New-Item -ItemType Directory -Force -Path $logDir, (Join-Path $state 'tls') | Out-Null
Protect-WhPath $state -Directory
Protect-WhPath (Join-Path $state 'tls') -Directory
if (-not (Test-CertOk)) {
  $r = Invoke-WhQuiet $mkcert @('-cert-file', $cert, '-key-file', $key, $Hostname)
  if ($r.ExitCode -ne 0) { Stop-WhScript "mkcert couldn't issue a certificate for $Hostname (exit $($r.ExitCode))" 1 }
  Write-Host "Issued a certificate for $Hostname"
}
Protect-WhPath $key
Write-WhUtf8File $caddyfile ($caddyfileBody + "`n")
$r = Invoke-WhQuiet $caddy @('validate', '--config', $caddyfile, '--adapter', 'caddyfile')
if ($r.ExitCode -ne 0) {
  Write-WhError "Caddyfile failed validation: $caddyfile"
  $ErrorActionPreference = 'Continue'
  & $caddy validate --config $caddyfile --adapter caddyfile 2>&1 | Select-Object -Last 3 | ForEach-Object { Write-WhError ([string]$_) }
  exit 1
}

Show-Unmanaged
foreach ($label in $want) {
  Install-WhAgent $label (Get-Launcher $label) $Repo
}

$ports = @([int]$publicPort, [int]$apiPort)
if ($notesOn) { $ports += [int]$notesLocalPort }
if ($codeOn) { $ports += [int]$codeLocalPort }
for ($i = 0; $i -lt 60; $i++) {
  $ok = $true
  foreach ($p in $ports) { if (-not (Test-WhListening $p)) { $ok = $false } }
  if ($ok) {
    Write-Host "Installed. Logs in $logDir"
    Write-Host "Windows Firewall may ask whether Caddy may accept connections: allow it on Private networks (or run, elevated: $firewallHint)."
    if (-not $NoLink) {
      $auth = Join-Path $Repo 'scripts\windows\setup-auth.ps1'
      $global:LASTEXITCODE = 0
      $authOk = $true
      try { & $auth -Apply -Hostname $Hostname -Port $publicPort; $authOk = ($LASTEXITCODE -eq 0) }
      catch { Write-WhError $_.Exception.Message; $authOk = $false }
      if (-not $authOk) { Stop-WhScript "Couldn't copy the sign-in link; run scripts\windows\setup-auth.ps1 -Apply -Hostname $Hostname" 1 }
    } else {
      Write-Host "Open $site; scripts\windows\setup-auth.ps1 -Apply -Hostname $Hostname copies the first sign-in link."
    }
    exit 0
  }
  Start-Sleep -Milliseconds 500
}
Write-WhError "Tasks started but not all listening yet; see $logDir"
exit 1
