#!/usr/bin/env bash
# LAN access for work-hub (macOS, Linux): serve the app at https://<hostname> to other devices, behind the auth plugin's
# sign-in. Installs agents that run at login (launchd LaunchAgents on macOS; systemd user units on Linux, see
# scripts/lib/service.sh), labelled ${WORK_HUB_LAUNCHD_PREFIX:-com.<user>.work-hub}:
#   <prefix>        the node server on 127.0.0.1:$WORK_HUB_PORT (loopback only), with WORK_HUB_HOSTNAME set
#   <prefix>-tls    Caddy serving https://<hostname> (port $WORK_HUB_PUBLIC_PORT, default 443) on the LAN, proxying to node
#   <prefix>-notes  SilverBullet under /notes, only if the notes plugin is on (loopback only)
#   <prefix>-code   VS Code serve-web under /code, only if the code plugin is on (loopback only, connection token)
#   <prefix>-term   the terminals plugin's daemon, only with --with-term, and only if that plugin is on with
#                   settings.terminals.autostart = false (replacing it ends every shell, so it's never touched otherwise)
# /notes and /code are served on the same origin only to requests work-hub says are signed in (Caddy forward_auth ->
# /auth-check). The certificate is issued by mkcert's local CA into <state>/tls (renewed when missing, wrong or within
# 30 days of expiry), so devices that trust "$(mkcert -CAROOT)/rootCA.pem" trust the site (scripts/trust-ca-mac.sh,
# scripts/share-ca.sh). Caddy is the LAN side because the macOS firewall prompts for (or blocks) a LAN-listening node.
# On Linux, Caddy needs permission to listen on a port below 1024 as you: `sudo setcap cap_net_bind_service=+ep <caddy>`
# (the dry run says so and --apply refuses without it), or set WORK_HUB_PUBLIC_PORT=8443. User units stop at logout
# unless `loginctl enable-linger $USER`.
#
# LAN access needs the auth plugin's sign-in (the server refuses to start with a hostname and no sign-in): if it's off in
# plugins.json, --apply turns it on ({"enabled": {"auth": true}}, the rest of the file kept). Once everything answers,
# --apply runs scripts/setup-auth.sh --apply, which creates the sign-in token if needed and copies the one-tap sign-in
# link to the clipboard (never printed); --no-link skips that (run setup-auth.sh yourself later).
#
# Only the agents this run manages are written or replaced; an installed agent for a plugin that is off now is left
# alone (remove it with that plugin's setup/install-agent.sh --uninstall, or --uninstall here). Every plist is stamped
# with this checkout (EnvironmentVariables.WORK_HUB_REPO; units: Environment=WORK_HUB_REPO=…), and an existing one that
# points at another checkout is never replaced, booted out or removed unless --adopt is given (scripts/lib/launchd.sh).
#
# Usage: setup-lan.sh --hostname <name> [--apply | --uninstall] [--with-term] [--adopt] [--no-link]   (or WORK_HUB_HOSTNAME=<name>)
#   --no-link     don't copy the sign-in link at the end
#   --uninstall   remove this checkout's agents (-term only with --with-term)
#   --with-term   also manage <prefix>-term (see above)
#   --adopt       take over plists (units) that point at another checkout (e.g. after moving the repo)
# Dry run by default: prints what it would install. Env: WORK_HUB_STATE_DIR, WORK_HUB_CONFIG_DIR, WORK_HUB_CACHE_DIR,
# WORK_HUB_PLUGINS_FILE, WORK_HUB_PORT (4848), WORK_HUB_PUBLIC_PORT (443), WORK_HUB_LAUNCHD_PREFIX,
# WORK_HUB_LAUNCH_AGENTS_DIR, WORK_HUB_SYSTEMD_USER_DIR, WORK_HUB_CADDY, WORK_HUB_MKCERT. Plugin settings read from
# plugins.json: notes.{notesDir,localPort,silverbullet}, code.{localPort,cli,vscodeTokenFile}, terminals.autostart.
set -euo pipefail

MODE="dry-run"
HOSTNAME_="${WORK_HUB_HOSTNAME:-}"
WITH_TERM=false
ADOPT=false
LINK=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --uninstall) MODE="uninstall" ;;
    --with-term) WITH_TERM=true ;;
    --adopt) ADOPT=true ;;
    --no-link) LINK=false ;;
    --hostname) HOSTNAME_="${2:-}"; shift ;;
    --hostname=*) HOSTNAME_="${1#--hostname=}" ;;
    -h|--help) sed -n '2,37p' "$0"; exit 0 ;;
    *) echo "usage: $0 --hostname <name> [--apply|--uninstall] [--with-term] [--adopt] [--no-link]" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/launchd.sh
source "$REPO/scripts/lib/launchd.sh"
agent_require_backend
PREFIX="${WORK_HUB_LAUNCHD_PREFIX:-$LAUNCHD_PREFIX_DEFAULT}"
LABELS=("$PREFIX" "$PREFIX-tls" "$PREFIX-notes" "$PREFIX-code")
[[ "$WITH_TERM" == true ]] && LABELS+=("$PREFIX-term")
AGENTS="$AGENTS_DIR"
STATE="${WORK_HUB_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/work-hub}"
CONFIG="${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}"
CACHE="${WORK_HUB_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/work-hub}"
PLUGINS_FILE="${WORK_HUB_PLUGINS_FILE:-$CONFIG/plugins.json}"
LOG_DIR="$AGENT_LOG_DIR"
API_PORT="${WORK_HUB_PORT:-4848}"
PUBLIC_PORT="${WORK_HUB_PUBLIC_PORT:-443}"

unload() { agent_unload "$1"; }

if [[ "$MODE" == "uninstall" ]]; then
  launchd_check_owned apply "${LABELS[@]}" || exit 1
  [[ "$WITH_TERM" == true || ! -e "$(agent_file "$PREFIX-term")" ]] || echo "Left $PREFIX-term alone (it ends every shell): add --with-term to remove it too."
  for label in "${LABELS[@]}"; do
    [[ -e "$(agent_file "$label")" ]] || continue
    unload "$label"
    rm -f "$(agent_file "$label")"
    echo "Removed $label"
  done
  agent_forget
  exit 0
fi

[[ -n "$HOSTNAME_" ]] || { echo "A hostname is required: --hostname <name> or WORK_HUB_HOSTNAME (a name your devices resolve to this machine)" >&2; exit 2; }
[[ "$HOSTNAME_" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Not a hostname: $HOSTNAME_" >&2; exit 2; }
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "node not found on PATH" >&2; exit 1; }

# Which plugins are on (plugins.json "enabled", else each manifest's defaultEnabled) and their settings, as KEY=value lines.
read_plugins() {
  "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const [file, dir] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error(`can not read ${file}: ${e.message}`); process.exit(3); } }
    const on = (id) => {
      if (cfg.enabled && typeof cfg.enabled[id] === "boolean") return cfg.enabled[id];
      try { return !!JSON.parse(fs.readFileSync(path.join(dir, id, "plugin.json"), "utf8")).defaultEnabled; } catch { return false; }
    };
    const s = (id, key) => { const v = cfg.settings?.[id]?.[key]; return v === undefined || v === null ? "" : String(v).replace(/\n/g, " "); };
    const out = {
      AUTH_ON: on("auth"), NOTES_ON: on("notes"), CODE_ON: on("code"), TERM_ON: on("terminals"),
      NOTES_DIR_S: s("notes", "notesDir"), NOTES_PORT_S: s("notes", "localPort"), SILVERBULLET_S: s("notes", "silverbullet"), NOTES_URL_S: s("notes", "url"),
      CODE_PORT_S: s("code", "localPort"), VSCODE_CLI_S: s("code", "cli"), VSCODE_TOKEN_S: s("code", "vscodeTokenFile"), CODE_URL_S: s("code", "url"),
      TERM_AUTOSTART_S: s("terminals", "autostart"),
    };
    for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
  ' "$PLUGINS_FILE" "$REPO/plugins"
}
PLUGIN_LINES="$(read_plugins)"
AUTH_ON=false NOTES_ON=false CODE_ON=false TERM_ON=false
NOTES_DIR_S="" NOTES_PORT_S="" SILVERBULLET_S="" NOTES_URL_S="" CODE_PORT_S="" VSCODE_CLI_S="" VSCODE_TOKEN_S="" CODE_URL_S="" TERM_AUTOSTART_S=""
while IFS='=' read -r k v; do
  case "$k" in
    AUTH_ON) AUTH_ON="$v" ;; NOTES_ON) NOTES_ON="$v" ;; CODE_ON) CODE_ON="$v" ;; TERM_ON) TERM_ON="$v" ;;
    NOTES_DIR_S) NOTES_DIR_S="$v" ;; NOTES_PORT_S) NOTES_PORT_S="$v" ;; SILVERBULLET_S) SILVERBULLET_S="$v" ;; NOTES_URL_S) NOTES_URL_S="$v" ;;
    CODE_PORT_S) CODE_PORT_S="$v" ;; VSCODE_CLI_S) VSCODE_CLI_S="$v" ;; VSCODE_TOKEN_S) VSCODE_TOKEN_S="$v" ;; CODE_URL_S) CODE_URL_S="$v" ;;
    TERM_AUTOSTART_S) TERM_AUTOSTART_S="$v" ;;
  esac
done <<<"$PLUGIN_LINES"

# Turns the auth plugin on in plugins.json (created if missing; everything else in it kept).
enable_auth() {
  "$NODE" -e '
    const fs = require("fs"), path = require("path");
    const file = process.argv[1];
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    cfg.enabled = { ...(cfg.enabled ?? {}), auth: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  ' "$PLUGINS_FILE"
}

NOTES_DIR="${NOTES_DIR_S:-${TW_NOTES_DIR:-$HOME/notes}}"
NOTES_LOCAL_PORT="${NOTES_PORT_S:-18744}"
NOTES_URL="${NOTES_URL_S:-/notes}"
SILVERBULLET="${SILVERBULLET_S:-${TW_SILVERBULLET_BIN:-$HOME/.local/bin/silverbullet}}"
CODE_LOCAL_PORT="${CODE_PORT_S:-18743}"
CODE_URL="${CODE_URL_S:-/code}"
if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then VSCODE_CLI_DEFAULT="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel"
else VSCODE_CLI_DEFAULT="$(command -v code-tunnel || command -v code || echo /usr/bin/code)"; fi
VSCODE_CLI="${VSCODE_CLI_S:-${TW_VSCODE_CLI:-$VSCODE_CLI_DEFAULT}}"
VSCODE_TOKEN_FILE="${VSCODE_TOKEN_S:-${TW_VSCODE_TOKEN_FILE:-$HOME/.local/state/vscode-serve-web.token}}"
WANT_TERM=false
[[ "$WITH_TERM" == true && "$TERM_ON" == true && "$TERM_AUTOSTART_S" == false ]] && WANT_TERM=true

CERT="$STATE/tls/$HOSTNAME_.pem"
KEY="$STATE/tls/$HOSTNAME_-key.pem"
MKCERT="${WORK_HUB_MKCERT:-$(find_tool mkcert)}"
CADDY="${WORK_HUB_CADDY:-$(find_tool caddy)}"
PNPM="$(command -v pnpm || true)"
if [[ "$PUBLIC_PORT" == 443 ]]; then SITE="https://$HOSTNAME_"; else SITE="https://$HOSTNAME_:$PUBLIC_PORT"; fi

missing=()
[[ -x "$CADDY" ]] || missing+=("Caddy ($(install_hint caddy); or WORK_HUB_CADDY)")
if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then
  [[ -x "$MKCERT" ]] || missing+=("mkcert (brew install mkcert; then mkcert -install; or WORK_HUB_MKCERT)")
else
  [[ -x "$MKCERT" ]] || missing+=("mkcert ($(install_hint mkcert), plus libnss3-tools / nss-tools for browsers; then scripts/trust-ca-linux.sh --apply; or WORK_HUB_MKCERT)")
fi
# Linux: an unprivileged user may only listen below 1024 when Caddy has the capability (or the sysctl allows it).
if [[ "$SERVICE_BACKEND" == systemd && "$PUBLIC_PORT" =~ ^[0-9]+$ && -x "$CADDY" ]] \
  && (( PUBLIC_PORT < $(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024) )); then
  CADDY_REAL="$(readlink -f "$CADDY" 2>/dev/null || echo "$CADDY")"
  if ! { command -v getcap >/dev/null 2>&1 && getcap "$CADDY_REAL" 2>/dev/null | grep -q cap_net_bind_service; }; then
    missing+=("permission for Caddy to listen on port $PUBLIC_PORT: sudo setcap cap_net_bind_service=+ep \"$CADDY_REAL\" (again after each Caddy upgrade), or WORK_HUB_PUBLIC_PORT=8443")
  fi
fi
[[ -n "$PNPM" ]] || missing+=("pnpm")
if [[ "$NOTES_ON" == true ]]; then [[ -x "$SILVERBULLET" ]] || missing+=("SilverBullet at $SILVERBULLET (settings.notes.silverbullet)"); fi
if [[ "$CODE_ON" == true ]]; then
  [[ -x "$VSCODE_CLI" ]] || missing+=("VS Code CLI at $VSCODE_CLI (settings.code.cli)")
  [[ -s "$VSCODE_TOKEN_FILE" ]] || missing+=("VS Code connection token file $VSCODE_TOKEN_FILE (settings.code.vscodeTokenFile)")
fi
if [[ ${#missing[@]} -gt 0 && "$MODE" == "apply" ]]; then
  printf 'Missing: %s\n' "${missing[@]}" >&2
  exit 1
fi

cert_ok() {
  [[ -s "$CERT" && -s "$KEY" ]] \
    && openssl x509 -in "$CERT" -noout -checkhost "$HOSTNAME_" 2>/dev/null | grep -q 'does match' \
    && openssl x509 -in "$CERT" -noout -checkend 2592000 >/dev/null
}

if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then
  # launchd gets a minimal PATH; give node the dirs for gh, claude, git, python3 and ioreg.
  GH_DIR="$(dirname "$(command -v gh || echo /opt/homebrew/bin/gh)")"
  PATH_DIRS="$(dirname "$NODE"):$GH_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/usr/bin:/bin"
else
  # systemd user units get a minimal PATH too: node's and gh's dirs, then the usual ones (claude, git, python3).
  GH_DIR="$(dirname "$(command -v gh || echo /usr/bin/gh)")"
  PATH_DIRS="$(dirname "$NODE"):$GH_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
fi

TOOLS_BLOCK=""
if [[ "$NOTES_ON" == true || "$CODE_ON" == true ]]; then
  MATCH="" ROUTES=""
  if [[ "$NOTES_ON" == true ]]; then
    MATCH="$MATCH $NOTES_URL $NOTES_URL/*"
    ROUTES="$ROUTES
		handle $NOTES_URL* {
			reverse_proxy 127.0.0.1:$NOTES_LOCAL_PORT
		}"
  fi
  if [[ "$CODE_ON" == true ]]; then
    MATCH="$MATCH $CODE_URL $CODE_URL/*"
    ROUTES="$ROUTES
		handle $CODE_URL* {
			reverse_proxy 127.0.0.1:$CODE_LOCAL_PORT
		}"
  fi
  TOOLS_BLOCK="
	# Notes and VS Code: only for requests work-hub says are signed in (else it redirects to /login).
	@tools path$MATCH
	handle @tools {
		forward_auth 127.0.0.1:$API_PORT {
			uri /auth-check
		}$ROUTES
	}
"
fi

CADDYFILE_BODY="{
	admin off
	auto_https off
}
$SITE {
	tls \"$CERT\" \"$KEY\"

	# Compress responses (the SSE stream and the app bundle are text). Caddy flushes event streams as they come.
	encode zstd gzip
$TOOLS_BLOCK
	handle {
		reverse_proxy 127.0.0.1:$API_PORT
	}
}"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
env_xml() { # KEY VALUE ... -> <key>K</key><string>V</string>...
  local out=""
  while [[ $# -gt 1 ]]; do out="$out<key>$1</key><string>$(xml "$2")</string>"; shift 2; done
  printf '%s' "$out"
}

plist() { # label, program args (as <string> xml), EnvironmentVariables entries (xml; WORK_HUB_REPO is always added)
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>WorkingDirectory</key><string>$(xml "$REPO")</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>EnvironmentVariables</key><dict>$(launchd_repo_env_xml)$3</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/$1.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/$1.log")</string>
</dict>
</plist>
EOF
}

args_xml() { # ARG ... -> <string>A</string>...
  local out="" a
  for a in "$@"; do out="$out<string>$(xml "$a")</string>"; done
  printf '%s' "$out"
}

COMMON_ENV=(PATH "$PATH_DIRS" WORK_HUB_STATE_DIR "$STATE" WORK_HUB_CONFIG_DIR "$CONFIG" WORK_HUB_CACHE_DIR "$CACHE")
# Each agent's program and arguments (SPEC_ARGS) and environment as KEY VALUE pairs (SPEC_ENV; WORK_HUB_REPO is
# always added), the same for a plist and a unit.
agent_spec() {
  SPEC_ENV=()
  case "$1" in
    "$PREFIX")
      SPEC_ARGS=("$NODE" "$REPO/server/index.ts")
      SPEC_ENV=(NODE_ENV production WORK_HUB_HOSTNAME "$HOSTNAME_" WORK_HUB_PORT "$API_PORT" WORK_HUB_PUBLIC_PORT "$PUBLIC_PORT" "${COMMON_ENV[@]}") ;;
    "$PREFIX-tls") SPEC_ARGS=("$CADDY" run --config "$STATE/Caddyfile" --adapter caddyfile) ;;
    # SilverBullet on the notes folder under /notes, without its own login: work-hub's sign-in gates it, loopback only.
    "$PREFIX-notes")
      SPEC_ARGS=("$SILVERBULLET" --single -L 127.0.0.1 -p "$NOTES_LOCAL_PORT" "$NOTES_DIR")
      SPEC_ENV=(SB_URL_PREFIX "$NOTES_URL" SB_SHELL_BACKEND off) ;;
    # VS Code serve-web under /code, keeping its connection token (work-hub hands it only to signed-in users).
    "$PREFIX-code")
      SPEC_ARGS=("$VSCODE_CLI" serve-web --accept-server-license-terms --host 127.0.0.1 --port "$CODE_LOCAL_PORT"
        --server-base-path "$CODE_URL" --connection-token-file "$VSCODE_TOKEN_FILE") ;;
    # The terminals plugin's daemon; its shells outlive restarts of the main server.
    "$PREFIX-term")
      SPEC_ARGS=("$NODE" "$REPO/plugins/terminals/termd.ts")
      SPEC_ENV=(LANG en_US.UTF-8 WORK_HUB_TERMD_LOG "$LOG_DIR/$PREFIX-term.log" "${COMMON_ENV[@]}") ;;
  esac
}

WANT=("$PREFIX" "$PREFIX-tls")
[[ "$NOTES_ON" == true ]] && WANT+=("$PREFIX-notes")
[[ "$CODE_ON" == true ]] && WANT+=("$PREFIX-code")
[[ "$WANT_TERM" == true ]] && WANT+=("$PREFIX-term")

# Installed agents this run doesn't manage (their plugin is off, or -term without --with-term): never touched here.
unmanaged_notes() {
  local label w keep
  for label in "$PREFIX-notes" "$PREFIX-code" "$PREFIX-term"; do
    keep=false
    for w in "${WANT[@]}"; do [[ "$w" == "$label" ]] && keep=true; done
    [[ "$keep" == false && -e "$(agent_file "$label")" ]] || continue
    if [[ "$label" == "$PREFIX-term" && "$WITH_TERM" == false ]]; then
      echo "  $label is installed and left alone (pass --with-term to manage it; replacing it ends every shell)"
    else
      echo "  $label is installed but not managed this run (its plugin is off or doesn't need it); left alone"
    fi
  done
  return 0
}

plist_for() {
  agent_spec "$1"
  plist "$1" "$(args_xml "${SPEC_ARGS[@]}")" "$(env_xml ${SPEC_ENV[@]+"${SPEC_ENV[@]}"})"
}
unit_for() {
  agent_spec "$1"
  systemd_unit_body "$1" "$REPO" "$LOG_DIR/$1.log" ${SPEC_ENV[@]+"${SPEC_ENV[@]}"} -- "${SPEC_ARGS[@]}"
}

if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry run. With --apply this would build the UI, then install into $AGENTS:"
  echo "  $PREFIX         node on 127.0.0.1:$API_PORT (WORK_HUB_HOSTNAME=$HOSTNAME_, state $STATE)"
  echo "  $PREFIX-tls     Caddy on $SITE"
  [[ "$NOTES_ON" == true ]] && echo "  $PREFIX-notes   SilverBullet on 127.0.0.1:$NOTES_LOCAL_PORT ($NOTES_DIR), served at $SITE$NOTES_URL"
  [[ "$CODE_ON" == true ]] && echo "  $PREFIX-code    VS Code serve-web on 127.0.0.1:$CODE_LOCAL_PORT, served at $SITE$CODE_URL"
  [[ "$WANT_TERM" == true ]] && echo "  $PREFIX-term    terminal daemon (terminals.autostart is false)"
  [[ "$AUTH_ON" != true ]] && echo "  would turn on the auth plugin (sign-in) in $PLUGINS_FILE: it's off, and LAN access needs it"
  if cert_ok; then echo "  certificate $CERT is valid"; else echo "  would issue a certificate for $HOSTNAME_ at $CERT (mkcert)"; fi
  [[ ${#missing[@]} -gt 0 ]] && printf '  missing (needed for --apply): %s\n' "${missing[@]}"
  launchd_check_owned dry-run "${WANT[@]}"
  unmanaged_notes
  echo "  $STATE/Caddyfile:"
  sed 's/^/    /' <<<"$CADDYFILE_BODY"
  if [[ "$LINK" == true ]]; then echo "  would then copy the sign-in link for $SITE to the clipboard (scripts/setup-auth.sh --apply)"; fi
  agent_linger_note
  echo "Re-run with --apply to install."
  exit 0
fi

launchd_check_owned apply "${WANT[@]}" || exit 1
if [[ "$AUTH_ON" != true ]]; then
  enable_auth
  echo "Turned on the auth plugin (sign-in) in $PLUGINS_FILE"
fi
(cd "$REPO" && "$PNPM" build >/dev/null)
mkdir -p "$LOG_DIR" "$AGENTS" "$STATE/tls"
chmod 700 "$STATE" "$STATE/tls"
if ! cert_ok; then
  (umask 077; "$MKCERT" -cert-file "$CERT" -key-file "$KEY" "$HOSTNAME_" >/dev/null 2>&1)
  echo "Issued a certificate for $HOSTNAME_"
fi
chmod 600 "$KEY"
printf '%s\n' "$CADDYFILE_BODY" > "$STATE/Caddyfile"
"$CADDY" validate --config "$STATE/Caddyfile" --adapter caddyfile >/dev/null 2>&1 \
  || { echo "Caddyfile failed validation: $STATE/Caddyfile" >&2; "$CADDY" validate --config "$STATE/Caddyfile" --adapter caddyfile 2>&1 | tail -3 >&2; exit 1; }

unmanaged_notes
for label in "${WANT[@]}"; do
  if [[ "$SERVICE_BACKEND" == systemd ]]; then
    unload "$label"
    unit_for "$label" > "$(agent_file "$label")"
    agent_load "$label" >/dev/null 2>&1 || { echo "couldn't start $label (systemctl --user status $label.service)" >&2; exit 1; }
    continue
  fi
  plist_for "$label" > "$AGENTS/$label.plist"
  plutil -lint "$AGENTS/$label.plist" >/dev/null || { echo "bad plist: $AGENTS/$label.plist" >&2; exit 1; }
  unload "$label"
  # bootout returns before launchd has fully let go, and an immediate bootstrap can fail with "5: Input/output error".
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist" 2>/dev/null && break
    [[ $attempt == 10 ]] && { echo "couldn't load $label" >&2; exit 1; }
    sleep 0.5
  done
done

listening() { port_listening "$1"; }
for _ in $(seq 1 60); do
  ok=true
  listening "$PUBLIC_PORT" || ok=false
  listening "$API_PORT" || ok=false
  if [[ "$NOTES_ON" == true ]]; then listening "$NOTES_LOCAL_PORT" || ok=false; fi
  if [[ "$CODE_ON" == true ]]; then listening "$CODE_LOCAL_PORT" || ok=false; fi
  if [[ "$ok" == true ]]; then
    echo "Installed. Logs in $LOG_DIR"
    agent_linger_note
    if [[ "$LINK" == true ]]; then
      "$REPO/scripts/setup-auth.sh" --apply --hostname "$HOSTNAME_" --port "$PUBLIC_PORT" \
        || { echo "Couldn't copy the sign-in link; run scripts/setup-auth.sh --apply --hostname $HOSTNAME_" >&2; exit 1; }
    else
      echo "Open $SITE; scripts/setup-auth.sh --apply --hostname $HOSTNAME_ copies the first sign-in link."
    fi
    exit 0
  fi
  sleep 0.5
done
echo "Agents loaded but not all listening yet; see $LOG_DIR" >&2
exit 1
