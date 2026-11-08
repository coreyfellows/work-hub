<#
.SYNOPSIS
The auth plugin's sign-in token and one-tap sign-in link (Windows twin of scripts/setup-auth.sh).

.DESCRIPTION
Creates the token if it isn't there (readable by you only, in the state dir) and copies the one-tap sign-in link
https://<hostname>[:<port>]/login#t=<token> to the clipboard (Set-Clipboard). The token is never printed: it sits in
the URL fragment, which the browser never sends to the server, and the login page drops it after use. After the first
sign-in, add a passkey or pair other devices from Settings.

Token file, in the order the server reads it: $env:WORK_HUB_AUTH_TOKEN_FILE, plugins.json settings.auth.tokenFile,
$env:WORK_HUB_TOKEN_FILE, <state dir>\token. Env: WORK_HUB_STATE_DIR, WORK_HUB_CONFIG_DIR / WORK_HUB_PLUGINS_FILE,
WORK_HUB_PUBLIC_PORT (443), WORK_HUB_LAUNCHD_PREFIX.

.PARAMETER Hostname
The name the app is served at (else $env:WORK_HUB_HOSTNAME).

.PARAMETER Port
The public (Caddy) port; default $env:WORK_HUB_PUBLIC_PORT, else 443.

.PARAMETER Apply
Create the token if missing and copy the link (without it: a dry run saying what would happen).

.PARAMETER Rotate
With -Apply: replace the token first, which signs every device out, and restart the server task setup-lan.ps1
installed; refused (before the token changes) if that task points at another checkout, unless -Adopt.

.PARAMETER Adopt
With -Rotate: restart the server task even if it points at another checkout.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\setup-auth.ps1 -Hostname hub.example.lan -Apply
#>
param(
  [string]$Hostname = $env:WORK_HUB_HOSTNAME,
  [string]$Port = $env:WORK_HUB_PUBLIC_PORT,
  [switch]$Apply,
  [switch]$Rotate,
  [switch]$Adopt
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows

if (-not $Port) { $Port = '443' }
if (-not $Hostname) { Stop-WhScript 'A hostname is required: -Hostname <name> or WORK_HUB_HOSTNAME (the name the app is served at)' 2 }
if ($Hostname -notmatch '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$') { Stop-WhScript "Not a hostname: $Hostname" 2 }
if ($Port -notmatch '^[0-9]+$') { Stop-WhScript "Not a port: $Port" 2 }

$state = Get-WhStateDir
$pluginsFile = Get-WhPluginsFile
$settingTokenFile = ''
if (-not $env:WORK_HUB_AUTH_TOKEN_FILE) {
  $cfg = Read-WhPluginsConfig $pluginsFile
  $v = Get-WhJsonValue $cfg @('settings', 'auth', 'tokenFile')
  if ($v -is [string]) { $settingTokenFile = $v }
}
$tokenFile = Select-WhFirst $env:WORK_HUB_AUTH_TOKEN_FILE $settingTokenFile $env:WORK_HUB_TOKEN_FILE (Join-Path $state 'token')
$tokenFile = [IO.Path]::GetFullPath($tokenFile)
$tokenDir = Split-Path -Parent $tokenFile
$prefix = Get-WhPrefix
if ($Port -eq '443') { $url = "https://$Hostname/login" } else { $url = "https://${Hostname}:$Port/login" }

function Test-TokenPresent { return ((Test-Path -LiteralPath $tokenFile -PathType Leaf) -and (Get-Item -LiteralPath $tokenFile).Length -gt 0) }

# 24 random bytes, base64url, like the server makes; written to a tmp file restricted to you before the token goes in.
function New-Token {
  $tmp = "$tokenFile.tmp"
  Write-WhUtf8File $tmp ''
  Protect-WhPath $tmp
  Write-WhUtf8File $tmp (New-WhRandomToken 24 'base64url')
  Move-Item -LiteralPath $tmp -Destination $tokenFile -Force
  Protect-WhPath $tokenFile
}

if (-not $Apply) {
  Write-Host 'Dry run (nothing changed):'
  if ($Rotate) {
    Write-Host "  would replace the token in $tokenFile, signing every device out, and restart $prefix if it's running"
    [void](Test-WhOwned 'dry-run' @($prefix) ([bool]$Adopt))
  } elseif (Test-TokenPresent) {
    Write-Host "  the token in $tokenFile exists; it would be left as is"
  } else {
    Write-Host "  would create a token in $tokenFile (yours only; its folder too if this script creates it or it is the state dir)"
  }
  Write-Host "  would copy the sign-in link for $url to the clipboard (the token is never printed)"
  Write-Host 'Re-run with -Apply.'
  exit 0
}

# Rotating restarts the server task: check it is this checkout's before anything changes.
if ($Rotate -and -not (Test-WhOwned 'apply' @($prefix) ([bool]$Adopt))) { exit 1 }
if (-not (Get-Command -Name Set-Clipboard -ErrorAction SilentlyContinue)) {
  Stop-WhScript 'Set-Clipboard not found: this script copies the link to the clipboard and never prints it' 1
}
# Restrict only a folder this script makes, or the state dir itself: never some existing parent the token file points into.
if (-not (Test-Path -LiteralPath $tokenDir -PathType Container)) {
  New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null
  Protect-WhPath $tokenDir -Directory
} elseif (Test-WhSamePath $tokenDir $state) {
  Protect-WhPath $tokenDir -Directory
}

if ($Rotate) {
  New-Token
  Write-Host 'Replaced the token; every device is signed out.'
  $task = Get-WhAgentTask $prefix
  if ($task -and ($Adopt -or (Test-WhPointsHere $prefix))) {
    Restart-WhAgent $prefix
    Write-Host "Restarted $prefix so it uses the new token."
  } else {
    Write-Host "Restart the server so it uses the new token ($prefix isn't installed as a Scheduled Task of this checkout)."
  }
} elseif (-not (Test-TokenPresent)) {
  New-Token
  Write-Host "Created a token in $tokenFile."
}
Protect-WhPath $tokenFile

$token = ([IO.File]::ReadAllText($tokenFile)).Trim()
Set-Clipboard -Value ($url + '#t=' + $token)
$token = $null
Write-Host "Copied the sign-in link for $url to the clipboard; paste it into the browser (it signs in once)."
