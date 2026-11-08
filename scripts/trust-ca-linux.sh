#!/usr/bin/env bash
# Trust the mkcert root CA on Linux, so browsers and tools accept https://<hostname> (scripts/setup-lan.sh) without a
# warning. The Linux twin of scripts/trust-ca-mac.sh.
#
# --apply runs `mkcert -install`, which adds the CA to the system trust store (update-ca-certificates or
# update-ca-trust, through sudo) and to the NSS databases Firefox and Chrome/Chromium use (needs certutil: apt install
# libnss3-tools / dnf install nss-tools; without it only the system store is updated). Idempotent. Then, given a
# hostname, it checks that the certificate the site serves now verifies (openssl s_client -verify_return_error).
#
# Non-interactive: `mkcert -install` calls sudo, which must not prompt here. If `sudo -n true` fails, it stops and
# asks you to run `sudo -v` first (that caches your password for a few minutes), then run this again.
#
# Usage: trust-ca-linux.sh [--hostname <name>] [--apply] [--remove]   (or WORK_HUB_HOSTNAME=<name>)
#   --apply     make the change (without it: a dry run saying what would happen)
#   --remove    take the CA back out (mkcert -uninstall) instead
# Env: WORK_HUB_HOSTNAME, WORK_HUB_PUBLIC_PORT (443), WORK_HUB_MKCERT (default: mkcert on PATH), WORK_HUB_CA_CERT.
set -euo pipefail

APPLY=false
REMOVE=false
HOST="${WORK_HUB_HOSTNAME:-}"
PORT="${WORK_HUB_PUBLIC_PORT:-443}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true ;;
    --remove) REMOVE=true ;;
    --hostname) HOST="${2:-}"; shift ;;
    --hostname=*) HOST="${1#--hostname=}" ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "usage: $0 [--hostname <name>] [--apply] [--remove]" >&2; exit 2 ;;
  esac
  shift
done

[[ "${WORK_HUB_PLATFORM:-$(uname -s)}" == Linux ]] || { echo "This script is for Linux; on macOS use scripts/trust-ca-mac.sh." >&2; exit 1; }
[[ -z "$HOST" || "$HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Not a hostname: $HOST" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Not a port: $PORT" >&2; exit 2; }

MKCERT="${WORK_HUB_MKCERT:-$(command -v mkcert || true)}"
[[ -n "$MKCERT" && -x "$MKCERT" ]] || { echo "mkcert not found: apt install mkcert / dnf install mkcert (or WORK_HUB_MKCERT)" >&2; exit 1; }
CA="${WORK_HUB_CA_CERT:-$("$MKCERT" -CAROOT)/rootCA.pem}"
if [[ -s "$CA" ]]; then
  grep -q 'PRIVATE KEY' "$CA" && { echo "$CA contains a private key; refusing" >&2; exit 1; }
  SUBJECT="$(openssl x509 -in "$CA" -noout -subject | sed 's/.*CN *= *//')"
else
  SUBJECT="(not created yet: mkcert -install creates it)"
fi
HAVE_CERTUTIL=false
command -v certutil >/dev/null 2>&1 && HAVE_CERTUTIL=true
NEED_SUDO=true
[[ "$(id -u)" == 0 ]] && NEED_SUDO=false

if [[ "$APPLY" == false ]]; then
  echo "Dry run (nothing changed):"
  if [[ "$REMOVE" == true ]]; then
    echo "  would run: mkcert -uninstall (takes $SUBJECT out of the system store and the browsers' NSS databases)"
  else
    echo "  would run: mkcert -install (adds $SUBJECT to the system store, through sudo, and to the browsers' NSS databases)"
    [[ "$HAVE_CERTUTIL" == true ]] || echo "  certutil not found: Firefox/Chrome would not be covered (apt install libnss3-tools / dnf install nss-tools)"
    if [[ -n "$HOST" ]]; then echo "  would then check that https://$HOST (port $PORT) verifies"; else echo "  (pass --hostname to check the served certificate afterwards)"; fi
  fi
  if [[ "$NEED_SUDO" == true ]] && ! sudo -n true 2>/dev/null; then
    echo "  sudo would prompt: run \`sudo -v\` first, then this with --apply"
  fi
  echo "Re-run with --apply."
  exit 0
fi

if [[ "$NEED_SUDO" == true ]] && ! sudo -n true 2>/dev/null; then
  echo "mkcert needs sudo for the system trust store, and sudo would prompt here: run \`sudo -v\` first, then run this again." >&2
  exit 1
fi

if [[ "$REMOVE" == true ]]; then
  "$MKCERT" -uninstall
  echo "Removed trust for $SUBJECT."
  exit 0
fi

[[ "$HAVE_CERTUTIL" == true ]] || echo "Note: certutil not found, so Firefox/Chrome won't trust it yet (apt install libnss3-tools / dnf install nss-tools, then run this again)."
"$MKCERT" -install
echo "Trusted: $(openssl x509 -in "$CA" -noout -subject | sed 's/.*CN *= *//')"
echo "SHA-256: $(openssl x509 -in "$CA" -noout -fingerprint -sha256 | sed 's/.*=//')"

[[ -n "$HOST" ]] || { echo "Pass --hostname <name> to check the certificate the site serves."; exit 0; }
# Check the certificate the site actually serves now verifies against the system store.
if ! out="$(openssl s_client -connect "$HOST:$PORT" -servername "$HOST" -verify_hostname "$HOST" -verify_return_error </dev/null 2>&1)"; then
  if grep -q 'Verify return code' <<<"$out" || grep -qi 'verify error' <<<"$out"; then
    echo "Trust added, but the served certificate still doesn't verify; check that $HOST resolves to this machine and serves the mkcert certificate (scripts/setup-lan.sh)." >&2
    exit 1
  fi
  echo "Trust added. (Couldn't reach $HOST:$PORT to double-check.)"
  exit 0
fi
echo "OK: https://$HOST (port $PORT) is now trusted on this machine. Restart the browser if it still warns."
