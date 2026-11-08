# The background-agent backend for the setup scripts, sourced by scripts/lib/launchd.sh (source that one, not this).
#
#   macOS (Darwin)  launchd LaunchAgents: <LAUNCH_AGENTS_DIR>/<label>.plist, logs in ~/Library/Logs/work-hub
#   Linux           systemd user units: ${WORK_HUB_SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-~/.config}/systemd/user}/<label>.service,
#                   logs appended to ${XDG_STATE_HOME:-~/.local/state}/work-hub/logs/<label>.log. User units stop when
#                   you log out unless lingering is on: `loginctl enable-linger $USER` (the scripts only say so).
#
# The platform is $WORK_HUB_PLATFORM (tests set it), else `uname -s`. Anything else (Windows: scripts/windows/) is
# "unsupported": the agent_* functions do nothing and report nothing loaded.
#
# Units carry the same ownership mark as plists: Environment="WORK_HUB_REPO=<checkout>" (WorkingDirectory as the
# fallback), checked by launchd_foreign_reason in launchd.sh before anything is stopped, replaced or removed.

WORK_HUB_PLATFORM="${WORK_HUB_PLATFORM:-$(uname -s)}"
case "$WORK_HUB_PLATFORM" in
  Darwin) SERVICE_BACKEND=launchd ;;
  Linux) SERVICE_BACKEND=systemd ;;
  *) SERVICE_BACKEND=unsupported ;;
esac
SYSTEMD_USER_DIR="${WORK_HUB_SYSTEMD_USER_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"
if [[ "$SERVICE_BACKEND" == systemd ]]; then
  AGENTS_DIR="$SYSTEMD_USER_DIR"
  AGENT_EXT=service
  AGENT_LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/work-hub/logs"
  AGENT_NOUN="systemd user unit"
  AGENT_FILE_NOUN=unit
else
  AGENTS_DIR="$LAUNCH_AGENTS_DIR"
  AGENT_EXT=plist
  AGENT_LOG_DIR="$HOME/Library/Logs/work-hub"
  AGENT_NOUN="launchd agent"
  AGENT_FILE_NOUN=plist
fi

agent_file() { printf '%s/%s.%s' "$AGENTS_DIR" "$1" "$AGENT_EXT"; }

# Exit with a clear message on a platform without a backend here.
agent_require_backend() {
  [[ "$SERVICE_BACKEND" != unsupported ]] && return 0
  echo "This script manages launchd agents (macOS) or systemd user units (Linux); $WORK_HUB_PLATFORM has neither here (on Windows, use scripts/windows/)." >&2
  exit 1
}

# Whether the service manager's CLI is on PATH.
agent_manager_available() {
  case "$SERVICE_BACKEND" in
    launchd) command -v launchctl >/dev/null 2>&1 ;;
    systemd) command -v systemctl >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Where agents run, for messages: gui/<uid> or systemd --user.
agent_domain() {
  if [[ "$SERVICE_BACKEND" == systemd ]]; then printf 'systemd --user'; else printf 'gui/%s' "$(id -u)"; fi
}

agent_loaded() {
  case "$SERVICE_BACKEND" in
    launchd) launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 ;;
    systemd) systemctl --user is-active --quiet "$1.service" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# Stop it and take it out of the session (launchd bootout; systemd disable --now). Never fails.
agent_unload() {
  case "$SERVICE_BACKEND" in
    launchd) launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true ;;
    systemd) systemctl --user disable --now "$1.service" >/dev/null 2>&1 || true ;;
  esac
  return 0
}

# Load the agent from its (already written) file and start it.
agent_load() {
  case "$SERVICE_BACKEND" in
    launchd) launchctl bootstrap "gui/$(id -u)" "$(agent_file "$1")" ;;
    systemd) systemctl --user daemon-reload && systemctl --user enable --now "$1.service" ;;
    *) return 1 ;;
  esac
}

agent_restart() {
  case "$SERVICE_BACKEND" in
    launchd) launchctl kickstart -k "gui/$(id -u)/$1" ;;
    systemd) systemctl --user restart "$1.service" ;;
    *) return 1 ;;
  esac
}

# The restart command for <label>, to print.
agent_restart_cmd() {
  if [[ "$SERVICE_BACKEND" == systemd ]]; then printf 'systemctl --user restart %s.service' "$1"
  else printf 'launchctl kickstart -k gui/%s/%s' "$(id -u)" "$1"; fi
}

# After a unit file is removed: let systemd forget it (launchd needs nothing).
agent_forget() {
  [[ "$SERVICE_BACKEND" == systemd ]] || return 0
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

# Labels the service manager knows that are <prefix> or start with <prefix>-, sorted (launchd: loaded in this login
# session; systemd: loaded units, active or not).
agent_list() {
  case "$SERVICE_BACKEND" in
    launchd) launchctl list | awk -v p="$1" 'NR > 1 && ($3 == p || index($3, p "-") == 1) { print $3 }' | sort -u ;;
    systemd)
      systemctl --user list-units --all --plain --no-legend --type=service 2>/dev/null \
        | awk -v p="$1" '{ u = ""; for (i = 1; i <= NF; i++) if ($i ~ /\.service$/) { u = $i; break }
            sub(/\.service$/, "", u); if (u != "" && (u == p || index(u, p "-") == 1)) print u }' | sort -u ;;
  esac
}

# On Linux, how to keep user units running after logout (printed, never run).
agent_linger_note() {
  [[ "$SERVICE_BACKEND" == systemd ]] || return 0
  local user="${USER:-$(id -un)}"
  if command -v loginctl >/dev/null 2>&1 && [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" == yes ]]; then return 0; fi
  echo "  note: systemd stops user units when you log out; to keep them running: loginctl enable-linger $user"
}

# Whether something listens on TCP <port> (lsof, else ss on Linux systems without lsof).
port_listening() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; fi
}

# A tool's path: on PATH, else (macOS) the Homebrew default, else empty.
find_tool() {
  local p
  if p="$(command -v "$1" 2>/dev/null)" && [[ -n "$p" ]]; then printf '%s' "$p"; return 0; fi
  if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then printf '/opt/homebrew/bin/%s' "$1"; fi
  return 0
}

# How to install a package, by platform (<brew name> [<apt/dnf name>]).
install_hint() {
  if [[ "$WORK_HUB_PLATFORM" == Darwin ]]; then printf 'brew install %s' "$1"
  else printf 'apt install %s / dnf install %s' "${2:-$1}" "${2:-$1}"; fi
}

# --- systemd unit files ---------------------------------------------------------------------------------------------

_sd_pct() { printf '%s' "${1//%/%%}"; } # % starts a specifier in unit files
_sd_quote() { # a "quoted" word for Environment=: \ and " escaped, % doubled
  local v="${1//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '"%s"' "${v//%/%%}"
}
_sd_exec_quote() { # the same for ExecStart=, where $ also expands
  local v
  v="$(_sd_quote "$1")"
  printf '%s' "${v//\$/\$\$}"
}

# A unit for <label>: systemd_unit_body <label> <working dir> <log file> [KEY VALUE]... -- <program> [arg]...
# Always stamped with Environment="WORK_HUB_REPO=$REPO". Restart=always matches the plists' KeepAlive.
systemd_unit_body() {
  local label="$1" wd="$2" log="$3" envs="" exec="" a
  shift 3
  while [[ $# -gt 1 && "$1" != -- ]]; do envs="${envs}Environment=$(_sd_quote "$1=$2")"$'\n'; shift 2; done
  [[ "${1:-}" == -- ]] && shift
  for a in "$@"; do exec="${exec:+$exec }$(_sd_exec_quote "$a")"; done
  printf '%s\n' "# Written by work-hub's setup scripts for the checkout in WORK_HUB_REPO; they only touch it from that checkout."
  printf '%s\n' "[Unit]" "Description=work-hub $label" "" "[Service]" "Type=simple"
  printf 'WorkingDirectory=%s\n' "$(_sd_pct "$wd")"
  printf 'Environment=%s\n' "$(_sd_quote "WORK_HUB_REPO=$REPO")"
  printf '%s' "$envs"
  printf 'ExecStart=%s\n' "$exec"
  printf '%s\n' "Restart=always" "RestartSec=2"
  printf 'StandardOutput=append:%s\n' "$(_sd_pct "$log")"
  printf 'StandardError=append:%s\n' "$(_sd_pct "$log")"
  printf '%s\n' "" "[Install]" "WantedBy=default.target"
}

# The words of a unit-file value, unquoted and unescaped, one per line.
_sd_words() {
  local w
  grep -oE '"([^"\\]|\\.)*"|[^[:space:]"]+' <<<"$1" | while IFS= read -r w; do
    if [[ "$w" == \"*\" && ${#w} -ge 2 ]]; then w="${w:1:${#w}-2}"; w="${w//\\\"/\"}"; w="${w//\\\\/\\}"; fi
    printf '%s\n' "${w//%%/%}"
  done
}

# The values of <Key>= lines in a unit file, one per line.
_sd_values() { sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//p" "$1" 2>/dev/null; }

# The checkout a unit points at: its WORK_HUB_REPO, else its WorkingDirectory; empty when it names neither.
systemd_unit_repo() {
  local line w
  while IFS= read -r line; do
    while IFS= read -r w; do
      if [[ "$w" == WORK_HUB_REPO=?* ]]; then printf '%s' "${w#WORK_HUB_REPO=}"; return 0; fi
    done < <(_sd_words "$line")
  done < <(_sd_values "$1" Environment)
  line="$(_sd_values "$1" WorkingDirectory | head -n 1)"
  line="${line#-}"
  [[ -n "$line" ]] && printf '%s' "${line//%%/%}"
  return 0
}

# A unit's ExecStart words (program and arguments), one per line.
systemd_unit_args() {
  local line
  while IFS= read -r line; do _sd_words "$line" | sed 's/\$\$/$/g'; done < <(_sd_values "$1" ExecStart)
}
