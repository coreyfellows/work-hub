# Shared by every script that writes, restarts or removes work-hub's launchd agents (scripts/setup-lan.sh,
# scripts/update.sh, scripts/setup-auth.sh, plugins/{notes,code}/setup/install-agent.sh). Source it after setting REPO
# (this checkout's absolute path). On Linux the same functions work on systemd user units instead (scripts/lib/service.sh,
# sourced below: the backend, unit files, agent_load/agent_unload/agent_restart/agent_list).
#
# Ownership: every plist these scripts write carries EnvironmentVariables.WORK_HUB_REPO = the checkout that wrote it,
# and nothing is booted out, overwritten, deleted or restarted unless its plist points at this checkout. A plist
# "points at" the checkout in its WORK_HUB_REPO, else (older plists) its WorkingDirectory, and any absolute `.ts`
# program argument must sit under that checkout too. Two checkouts on one Mac (say a copy you're trying out next to the
# one you run) can share a label prefix without one stopping the other's agents. `--adopt` (ADOPT=true) takes a
# foreign plist over on purpose.
#
# Env: WORK_HUB_LAUNCHD_PREFIX (label prefix), WORK_HUB_LAUNCH_AGENTS_DIR (default ~/Library/LaunchAgents; tests),
# WORK_HUB_SYSTEMD_USER_DIR (Linux; default ${XDG_CONFIG_HOME:-~/.config}/systemd/user), WORK_HUB_PLATFORM (tests:
# Darwin or Linux; default `uname -s`).

# The default label uses the login name with anything but letters, digits and "-" turned into "-" (a launchd label
# segment), so a user like first.last gets com.first-last.work-hub.
LABEL_USER=$(printf '%s' "${USER:-$(id -un)}" | tr -c 'A-Za-z0-9-' '-')
LAUNCHD_PREFIX_DEFAULT="com.$LABEL_USER.work-hub"
LAUNCH_AGENTS_DIR="${WORK_HUB_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
# shellcheck source=service.sh
source "$(dirname "${BASH_SOURCE[0]}")/service.sh"

_launchd_phys() { # a path with symlinks resolved when it exists, else as given (no trailing slash)
  if [[ -d "$1" ]]; then (cd "$1" && pwd -P); else printf '%s' "${1%/}"; fi
}
_launchd_get() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }

# The checkout a plist (on Linux: a unit) points at: its WORK_HUB_REPO, else its WorkingDirectory; empty when it names
# neither.
launchd_plist_repo() {
  local v
  if [[ "$SERVICE_BACKEND" == systemd ]]; then systemd_unit_repo "$1"; return 0; fi
  if v="$(_launchd_get "$1" EnvironmentVariables.WORK_HUB_REPO)" && [[ -n "$v" ]]; then printf '%s' "$v"; return 0; fi
  if v="$(_launchd_get "$1" WorkingDirectory)" && [[ -n "$v" ]]; then printf '%s' "$v"; fi
  return 0
}

# Each program argument of an agent file, one per line.
_launchd_args() {
  local arg i=0
  if [[ "$SERVICE_BACKEND" == systemd ]]; then systemd_unit_args "$1"; return 0; fi
  while arg="$(_launchd_get "$1" "ProgramArguments.$i")"; do printf '%s\n' "$arg"; i=$((i + 1)); done
  return 0
}

# Why <label>'s agent isn't this checkout's to touch; prints nothing when it is, or when it has no plist (unit).
launchd_foreign_reason() {
  local f owner mine arg
  f="$(agent_file "$1")"
  [[ -e "$f" ]] || return 0
  mine="$(_launchd_phys "$REPO")"
  owner="$(launchd_plist_repo "$f")"
  if [[ -z "$owner" ]]; then echo "$f names no checkout (no WORK_HUB_REPO, no WorkingDirectory)"; return 0; fi
  if [[ "$(_launchd_phys "$owner")" != "$mine" ]]; then echo "$f points at $owner, not this checkout ($REPO)"; return 0; fi
  while IFS= read -r arg; do
    if [[ "$arg" == /*.ts && "$(_launchd_phys "$(dirname "$arg")")/" != "$mine"/* ]]; then
      echo "$f runs $arg, outside this checkout ($REPO)"; return 0
    fi
  done < <(_launchd_args "$f")
  return 0
}

# True when <label> has a plist (unit) and it points at this checkout (what update.sh restarts).
launchd_points_here() { [[ -e "$(agent_file "$1")" && -z "$(launchd_foreign_reason "$1")" ]]; }

# Check each label before acting on it. <mode> apply: prints why to stderr and returns 1 if any is foreign;
# anything else (a dry run): prints a warning and returns 0. With ADOPT=true foreign plists are taken over (noted).
launchd_check_owned() {
  local mode="$1" label reason bad=0
  shift
  for label in "$@"; do
    reason="$(launchd_foreign_reason "$label")"
    [[ -n "$reason" ]] || continue
    if [[ "${ADOPT:-false}" == true ]]; then
      echo "Adopting $label (--adopt): $reason"
    elif [[ "$mode" == apply ]]; then
      echo "Refusing to touch $label: $reason. Run it from that checkout, or pass --adopt to take it over." >&2
      bad=1
    else
      echo "  warning: --apply would refuse $label: $reason (pass --adopt to take it over)"
    fi
  done
  return $bad
}

# <key>WORK_HUB_REPO</key><string>…</string>, for the EnvironmentVariables dict of every plist written.
launchd_repo_env_xml() {
  printf '<key>WORK_HUB_REPO</key><string>%s</string>' "$(sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$REPO")"
}
