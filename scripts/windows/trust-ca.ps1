<#
.SYNOPSIS
Trust the mkcert root CA in your Windows *user* certificate store (no admin), so Edge, Chrome and other browsers that
use the Windows store accept https://<hostname> (scripts\windows\setup-lan.ps1) without a warning.

.DESCRIPTION
The Windows twin of scripts/trust-ca-mac.sh: `certutil -user -addstore Root <rootCA.pem>`. Windows shows a security
dialog to approve adding (or removing) a root certificate; that's the one click this needs. Idempotent: an already
trusted CA is left as is. Then it checks that the certificate https://<hostname> serves verifies.
Firefox keeps its own store unless security.enterprise_roots.enabled is on (it is by default on recent Windows builds).

Env: WORK_HUB_HOSTNAME, WORK_HUB_PUBLIC_PORT (443), WORK_HUB_CA_CERT (default "$(mkcert -CAROOT)\rootCA.pem", i.e.
%LOCALAPPDATA%\mkcert), WORK_HUB_MKCERT.

.PARAMETER Hostname
The name the site is served at, to check the served certificate (else $env:WORK_HUB_HOSTNAME).

.PARAMETER Remove
Take the CA back out of the user store.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\trust-ca.ps1 -Hostname hub.example.lan
#>
param(
  [string]$Hostname = $env:WORK_HUB_HOSTNAME,
  [switch]$Remove
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows

$ca = $env:WORK_HUB_CA_CERT
if (-not $ca) {
  $mkcert = Select-WhFirst $env:WORK_HUB_MKCERT (Find-WhTool @('mkcert'))
  if (-not $mkcert) { Stop-WhScript 'mkcert not found (winget install FiloSottile.mkcert), or set WORK_HUB_CA_CERT' 1 }
  $ca = Join-Path (Invoke-WhOutput $mkcert @('-CAROOT')) 'rootCA.pem'
}
$port = [int](Select-WhFirst $env:WORK_HUB_PUBLIC_PORT '443')
$certutil = Join-Path $env:SystemRoot 'System32\certutil.exe'

if (-not (Test-Path -LiteralPath $ca -PathType Leaf) -or (Get-Item -LiteralPath $ca).Length -eq 0) {
  Stop-WhScript "No root CA certificate at $ca" 1
}
$pem = [IO.File]::ReadAllText($ca)
if ($pem.Contains('PRIVATE KEY')) { Stop-WhScript "$ca contains a private key; refusing" 1 }

# The first certificate in the PEM file, from its DER bytes (works on .NET Framework and .NET alike).
$m = [regex]::Match($pem, '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----')
if (-not $m.Success) { Stop-WhScript "$ca holds no PEM certificate" 1 }
$der = [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s', ''))
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, $der)
$thumb = $cert.Thumbprint
$name = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $sha256 = (($sha.ComputeHash($der) | ForEach-Object { $_.ToString('X2') }) -join ':') } finally { $sha.Dispose() }
$installed = Test-Path -LiteralPath "Cert:\CurrentUser\Root\$thumb"

if ($Remove) {
  if ($installed) {
    Write-Host 'Approve the Windows dialog that appears...'
    $r = Invoke-WhQuiet $certutil @('-user', '-delstore', 'Root', $thumb)
    if ($r.ExitCode -ne 0) { Stop-WhScript "certutil couldn't remove $name (exit $($r.ExitCode); declined?)" 1 }
  }
  Write-Host "Removed trust for $name"
  exit 0
}

if (-not $Hostname) { Stop-WhScript 'A hostname is required to check the served certificate: -Hostname <name> or WORK_HUB_HOSTNAME' 2 }

Write-Host "Trusting: $name"
Write-Host "SHA-256:  $sha256"
if ($installed) {
  Write-Host 'Already in your user Root store.'
} else {
  Write-Host 'Approve the Windows security dialog that appears...'
  $r = Invoke-WhQuiet $certutil @('-user', '-addstore', 'Root', $ca)
  if ($r.ExitCode -ne 0) { Stop-WhScript "certutil couldn't add $name to your Root store (exit $($r.ExitCode); declined?)" 1 }
}

# Check the certificate the site actually serves now verifies (a TLS 1.2 handshake with the default validation, which
# uses the Windows store, the hostname checked too).
function Test-ServedCert([string]$Name, [int]$TcpPort) {
  $tcp = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $tcp.BeginConnect($Name, $TcpPort, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(5000)) { return 'unreachable' }
    $tcp.EndConnect($iar)
  } catch {
    $tcp.Close()
    return 'unreachable'
  }
  try {
    $ssl = New-Object System.Net.Security.SslStream -ArgumentList $tcp.GetStream(), $false
    try {
      $ssl.AuthenticateAsClient($Name, $null, [System.Security.Authentication.SslProtocols]::Tls12, $false)
      return 'trusted'
    } finally { $ssl.Dispose() }
  } catch {
    return 'untrusted'
  } finally {
    $tcp.Close()
  }
}

switch (Test-ServedCert $Hostname $port) {
  'trusted' {
    Write-Host "OK: https://$Hostname (port $port) is now trusted on this PC. Reload the page (restart the browser if it still warns)."
  }
  'untrusted' {
    Write-WhError "Trust added, but Windows still doesn't verify the served certificate; check that $Hostname resolves to this PC and serves the mkcert certificate (scripts\windows\setup-lan.ps1)."
    exit 1
  }
  default {
    Write-Host "Trust added. (Couldn't reach ${Hostname}:$port to double-check.)"
  }
}
