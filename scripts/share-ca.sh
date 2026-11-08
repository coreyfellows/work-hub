#!/usr/bin/env bash
# Put the mkcert root CA *certificate* (public; never the -key file) in ~/Downloads and reveal it in
# Finder, so you can AirDrop it to your phone. On iPhone: open it, install the profile under
# Settings → General → VPN & Device Management, then turn on full trust under
# Settings → General → About → Certificate Trust Settings. Passkeys need that full trust. (A signed-in device can
# also download it from https://<hostname>/ca.pem, the auth plugin's route.) Env: WORK_HUB_CA_CERT.
# On Linux it goes to ${XDG_DOWNLOAD_DIR:-~/Downloads} and that folder is opened with xdg-open when there is one (else
# the path is printed); send it to your phone however suits you (e.g. KDE Connect / GSConnect, email).
set -euo pipefail

PLATFORM="${WORK_HUB_PLATFORM:-$(uname -s)}"
SRC="${WORK_HUB_CA_CERT:-$(mkcert -CAROOT)/rootCA.pem}"
if [[ "$PLATFORM" == Darwin ]]; then DEST_DIR="$HOME/Downloads"; else DEST_DIR="${XDG_DOWNLOAD_DIR:-$HOME/Downloads}"; fi
DEST="$DEST_DIR/work-hub-rootCA.pem"
[[ -s "$SRC" ]] || { echo "No mkcert root CA at $SRC" >&2; exit 1; }
grep -q 'PRIVATE KEY' "$SRC" && { echo "$SRC contains a private key; refusing" >&2; exit 1; }
if [[ "$PLATFORM" == Darwin ]]; then
  cp "$SRC" "$DEST"
  open -R "$DEST"
  echo "Copied the root CA certificate to $DEST and revealed it in Finder; AirDrop it to your phone."
  exit 0
fi
mkdir -p "$DEST_DIR"
cp "$SRC" "$DEST"
if command -v xdg-open >/dev/null 2>&1 && xdg-open "$DEST_DIR" >/dev/null 2>&1; then
  echo "Copied the root CA certificate to $DEST and opened its folder; send it to your phone."
else
  echo "Copied the root CA certificate to $DEST; send it to your phone."
fi
