#!/usr/bin/env bash
# Trust the mkcert root CA in your macOS *login* keychain (user level, no sudo), so Safari, Chrome and
# other keychain-backed browsers accept https://<hostname> (scripts/setup-lan.sh) without a warning.
# macOS shows a password / Touch ID dialog to approve the trust change. Idempotent.
# Usage: trust-ca-mac.sh --hostname <name> | --remove   (or WORK_HUB_HOSTNAME=<name>; WORK_HUB_PUBLIC_PORT, WORK_HUB_CA_CERT)
#   --remove  take the trust (and certificate) back out
set -euo pipefail

REMOVE=false
HOST="${WORK_HUB_HOSTNAME:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remove) REMOVE=true ;;
    --hostname) HOST="${2:-}"; shift ;;
    --hostname=*) HOST="${1#--hostname=}" ;;
    *) echo "usage: $0 --hostname <name> | --remove" >&2; exit 2 ;;
  esac
  shift
done

CA="${WORK_HUB_CA_CERT:-$(mkcert -CAROOT)/rootCA.pem}"
PORT="${WORK_HUB_PUBLIC_PORT:-443}"
KC="$HOME/Library/Keychains/login.keychain-db"

[[ -s "$CA" ]] || { echo "No root CA certificate at $CA" >&2; exit 1; }
grep -q 'PRIVATE KEY' "$CA" && { echo "$CA contains a private key; refusing" >&2; exit 1; }

if [[ "$REMOVE" == true ]]; then
  security remove-trusted-cert "$CA" 2>/dev/null || true
  security delete-certificate -Z "$(openssl x509 -in "$CA" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')" "$KC" 2>/dev/null || true
  echo "Removed trust for $(openssl x509 -in "$CA" -noout -subject | sed 's/.*CN=//')"
  exit 0
fi

[[ -n "$HOST" ]] || { echo "A hostname is required to check the served certificate: --hostname <name> or WORK_HUB_HOSTNAME" >&2; exit 2; }

echo "Trusting: $(openssl x509 -in "$CA" -noout -subject | sed 's/.*CN=//')"
echo "SHA-256:  $(openssl x509 -in "$CA" -noout -fingerprint -sha256 | sed 's/.*=//')"
echo "Approve the macOS dialog that appears…"
security add-trusted-cert -r trustRoot -p ssl -k "$KC" "$CA"

# Check the certificate the site actually serves now verifies.
SERVED="$(mktemp)"
trap 'rm -f "$SERVED"' EXIT
if echo | openssl s_client -connect "$HOST:$PORT" -servername "$HOST" 2>/dev/null | openssl x509 > "$SERVED" 2>/dev/null; then
  if security verify-cert -c "$SERVED" -p ssl -s "$HOST" >/dev/null 2>&1; then
    echo "OK: https://$HOST (port $PORT) is now trusted on this Mac. Reload the page (restart the browser if it still warns)."
  else
    echo "Trust added, but macOS still doesn't verify the served certificate; check that $HOST resolves to this Mac and serves the mkcert certificate (scripts/setup-lan.sh)." >&2
    exit 1
  fi
else
  echo "Trust added. (Couldn't reach $HOST:$PORT to double-check.)"
fi
