<#
.SYNOPSIS
Put the mkcert root CA *certificate* (public; never the -key file) in your Downloads folder and select it in Explorer,
so you can send it to your phone (the Windows twin of scripts/share-ca.sh).

.DESCRIPTION
Send the file to the phone any way you like (Phone Link, email, a cloud drive, USB); a signed-in device can also
download it from https://<hostname>/ca.pem, the auth plugin's route. On iPhone: open it, install the profile under
Settings > General > VPN & Device Management, then turn on full trust under
Settings > General > About > Certificate Trust Settings. Passkeys need that full trust. On Android: Settings >
Security > Encryption & credentials > Install a certificate > CA certificate.
Env: WORK_HUB_CA_CERT (default "$(mkcert -CAROOT)\rootCA.pem", i.e. %LOCALAPPDATA%\mkcert), WORK_HUB_MKCERT.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\share-ca.ps1
#>
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
. (Join-Path $PSScriptRoot 'lib\Agents.ps1')
Assert-WhWindows

$src = $env:WORK_HUB_CA_CERT
if (-not $src) {
  $mkcert = Select-WhFirst $env:WORK_HUB_MKCERT (Find-WhTool @('mkcert'))
  if (-not $mkcert) { Stop-WhScript 'mkcert not found (winget install FiloSottile.mkcert), or set WORK_HUB_CA_CERT' 1 }
  $src = Join-Path (Invoke-WhOutput $mkcert @('-CAROOT')) 'rootCA.pem'
}
if (-not (Test-Path -LiteralPath $src -PathType Leaf) -or (Get-Item -LiteralPath $src).Length -eq 0) {
  Stop-WhScript "No mkcert root CA at $src" 1
}
if (([IO.File]::ReadAllText($src)).Contains('PRIVATE KEY')) { Stop-WhScript "$src contains a private key; refusing" 1 }

# The Downloads known folder (it can be moved), else <home>\Downloads.
$downloads = ''
try {
  $shell = New-Object -ComObject Shell.Application
  $downloads = [string]($shell.NameSpace('shell:Downloads').Self.Path)
} catch { }
if (-not $downloads) { $downloads = Join-Path $HOME 'Downloads' }
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$dest = Join-Path $downloads 'work-hub-rootCA.pem'

Copy-Item -LiteralPath $src -Destination $dest -Force
Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$dest`""
Write-Host "Copied the root CA certificate to $dest and selected it in Explorer; send it to your phone."
