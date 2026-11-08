#!/usr/bin/env bash
# Shared settings for every ticket-workflow script (work-hub's bundled copy). Source it:
#   . "$(dirname "$0")/config.sh"
# Values come from, highest first:
#   1. the environment;
#   2. work-hub's config file, $WORK_HUB_TW_CONFIG (default <work-hub config dir>/ticket-workflow.env, where the config
#      dir is $WORK_HUB_CONFIG_DIR or ${XDG_CONFIG_HOME:-~/.config}/work-hub);
#   3. a standalone ticket-workflow setup's ~/.config/ticket-workflow/config.env ($TICKET_WORKFLOW_CONFIG), if present;
#   4. the defaults below.
# Run it directly to print the effective settings:
#   config.sh [--print]

TW_CONFIG_FILE="${WORK_HUB_TW_CONFIG:-${WORK_HUB_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/work-hub}/ticket-workflow.env}"
TW_STANDALONE_CONFIG_FILE="${TICKET_WORKFLOW_CONFIG:-$HOME/.config/ticket-workflow/config.env}"

# Sourcing a file would let it override what's already in the environment, so remember which TW_* came from there and
# put them back afterwards. The work-hub file is sourced last, so it wins over the standalone one.
__tw_env=""
for __tw_v in $(compgen -v TW_ || true); do
  case "$__tw_v" in TW_CONFIG_FILE | TW_STANDALONE_CONFIG_FILE) continue ;; esac
  __tw_env+="$__tw_v=$(printf '%q' "${!__tw_v}");"
done
unset __tw_v
# shellcheck disable=SC1090
[ -r "$TW_STANDALONE_CONFIG_FILE" ] && . "$TW_STANDALONE_CONFIG_FILE"
# shellcheck disable=SC1090
[ -r "$TW_CONFIG_FILE" ] && . "$TW_CONFIG_FILE"
eval "$__tw_env"
unset __tw_env

# Worktrees live at $TW_WORKTREES_ROOT/<repo-name>/<TICKET or description>.
: "${TW_WORKTREES_ROOT:=$HOME/worktrees}"
# Ticket notes live at $TW_NOTES_DIR/tickets/<KEY>.md. work-hub's notes plugin serves them at $TW_NOTES_URL
# (a path on work-hub's own origin, or a full URL); TW_NOTES_PORT is the SilverBullet port behind it.
: "${TW_NOTES_DIR:=$HOME/notes}"
: "${TW_NOTES_URL:=/notes}"
TW_NOTES_URL="${TW_NOTES_URL%/}"
: "${TW_NOTES_PORT:=18734}"
: "${TW_SILVERBULLET_BIN:=$HOME/.local/bin/silverbullet}"
# Address the notes and VS Code servers listen on (set up by work-hub's notes and code plugins).
: "${TW_BIND_HOST:=127.0.0.1}"
: "${TW_NOTES_AUTH_FILE:=$HOME/.local/state/silverbullet-auth}"
# Optional HTTPS front of a standalone setup. Unused by work-hub; kept so a shared config file still parses the same.
: "${TW_TLS_HOSTNAME:=}"
: "${TW_TLS_VSCODE_PORT:=8733}"
: "${TW_TLS_NOTES_PORT:=8734}"
: "${TW_TLS_DIR:=$HOME/.local/state/tls}"
# On PATH first; the Homebrew paths are the macOS fallback.
: "${TW_CADDY_BIN:=$(command -v caddy 2>/dev/null || echo /opt/homebrew/bin/caddy)}"
: "${TW_MKCERT_BIN:=$(command -v mkcert 2>/dev/null || echo /opt/homebrew/bin/mkcert)}"
# The `code serve-web` server.
: "${TW_VSCODE_PORT:=18733}"
: "${TW_VSCODE_TOKEN_FILE:=$HOME/.local/state/vscode-serve-web.token}"
if [ "${WORK_HUB_PLATFORM:-$(uname -s)}" = Darwin ]; then
  : "${TW_VSCODE_CLI:=/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code-tunnel}"
else
  : "${TW_VSCODE_CLI:=$(command -v code-tunnel 2>/dev/null || command -v code 2>/dev/null || echo /usr/bin/code)}"
fi
# LaunchAgent label prefix of a standalone setup.
: "${TW_LAUNCHD_PREFIX:=com.$(id -un | tr -c 'A-Za-z0-9\n' '-')}"
# Window layout settings of a standalone setup (cmux). Unused by work-hub.
: "${TW_WIDE_DISPLAY_PT:=2560}"
: "${TW_CHROME_PROFILE:=Default}"
# Jira site, e.g. https://example.atlassian.net. Empty: no Jira links in ticket notes.
: "${TW_JIRA_BASE_URL:=}"
TW_JIRA_BASE_URL="${TW_JIRA_BASE_URL%/}"
# Install JS dependencies in new worktrees that have a pnpm-lock.yaml (1 or 0).
: "${TW_PNPM_INSTALL:=1}"
# Inject the ticket-workflow policy into every session work-hub starts (1 or 0).
: "${TW_INJECT_POLICY:=1}"

# Jira defaults for the ticket-defaults skill. All optional; see config.env.example.
: "${TW_JIRA_ACCOUNT_ID:=}"
: "${TW_JIRA_PROJECT:=}"
: "${TW_JIRA_BOARD_ID:=}"
: "${TW_JIRA_SPRINT_PREFIX:=}"
: "${TW_JIRA_SPRINT_FIELD:=customfield_10020}"
: "${TW_JIRA_POINTS_FIELD:=}"
: "${TW_JIRA_IN_PROGRESS_TRANSITION:=}"
: "${TW_JIRA_NO_PRIORITY:=}"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "# config file: $TW_CONFIG_FILE ($([ -r "$TW_CONFIG_FILE" ] && echo found || echo 'not found'))"
  echo "# standalone config file: $TW_STANDALONE_CONFIG_FILE ($([ -r "$TW_STANDALONE_CONFIG_FILE" ] && echo found || echo 'not found'))"
  for v in $(compgen -v TW_ | grep -v -e '^TW_CONFIG_FILE$' -e '^TW_STANDALONE_CONFIG_FILE$'); do printf '%s=%q\n' "$v" "${!v}"; done
fi
