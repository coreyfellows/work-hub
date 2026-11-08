#!/usr/bin/env bash
# Fresh-clone smoke test: clones this repo into a temp dir with an empty state dir and no plugins
# config, installs, builds, starts the server in production and checks it serves.
# Usage: scripts/fresh-clone-test.sh            (PORT=4868 by default; REPO=<path|url> to clone another repo)
# Never touches the real state/config dirs; everything lives in a mktemp dir that is removed on exit.
# See docs/fresh-clone-test.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${REPO:-$HERE}"
PORT="${PORT:-4868}"
WEB_PORT="${WEB_PORT:-4869}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/work-hub-fresh.XXXXXX")"
SERVER_PID=""
DAEMON_PID=""
FAILS=0

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  # Any other process still holding a socket in our temp dir (found by path, never by pattern).
  for p in $(lsof -U 2>/dev/null | awk -v t="$TMP" 'index($0, t) { print $2 }' | sort -u); do
    kill "$p" 2>/dev/null || true
  done
  sleep 0.3
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1${2:+ ($2)}"; FAILS=$((FAILS + 1)); }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "port $PORT is already in use; set PORT=<free port>" >&2
  exit 2
fi

echo "== clone $REPO -> $TMP/work-hub"
git clone --quiet "$REPO" "$TMP/work-hub"
cd "$TMP/work-hub"

export WORK_HUB_STATE_DIR="$TMP/state" WORK_HUB_CONFIG_DIR="$TMP/config" WORK_HUB_CACHE_DIR="$TMP/cache"
export WORK_HUB_PORT="$PORT" WORK_HUB_WEB_PORT="$WEB_PORT"
unset WORK_HUB_HOSTNAME
mkdir -p "$WORK_HUB_STATE_DIR" "$WORK_HUB_CONFIG_DIR" "$WORK_HUB_CACHE_DIR"

echo "== pnpm install"
pnpm install --offline --frozen-lockfile >"$TMP/install.log" 2>&1 \
  || pnpm install --frozen-lockfile >>"$TMP/install.log" 2>&1 \
  || { tail -20 "$TMP/install.log"; echo "FAIL  install"; exit 1; }
echo "== pnpm build"
pnpm build >"$TMP/build.log" 2>&1 || { tail -30 "$TMP/build.log"; echo "FAIL  build"; exit 1; }

echo "== start server on $PORT"
NODE_ENV=production node server/index.ts >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

BASE="http://127.0.0.1:$PORT"
up=0
for _ in $(seq 1 60); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  if curl -fsS "$BASE/api/status" >/dev/null 2>&1; then up=1; break; fi
  sleep 0.5
done
if [ "$up" != 1 ]; then
  tail -30 "$TMP/server.log"
  echo "FAIL  server did not come up within 30s"
  exit 1
fi

# GET <path> -> sets CODE and BODY
get() { BODY="$(curl -sS -o - -w '\n%{http_code}' "$BASE$1" "${@:2}")"; CODE="${BODY##*$'\n'}"; BODY="${BODY%$'\n'*}"; }
json() { printf '%s' "$BODY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])))})' "$1"; }

get /
if [ "$CODE" = 200 ] && printf '%s' "$BODY" | grep -qi '<title>[^<]*work-hub'; then pass "GET / serves the UI (title has work-hub)"; else fail "GET /" "http $CODE, $(printf '%s' "$BODY" | grep -io '<title>[^<]*' | head -1)"; fi

get /api/status
if [ "$CODE" = 200 ]; then pass "GET /api/status"; else fail "GET /api/status" "http $CODE"; fi

get /api/state
if [ "$CODE" = 200 ]; then
  ids="$(json '(Array.isArray(j) ? j : Object.values(j.sources ?? j)).map(s => s.id).join(",")' 2>/dev/null || true)"
  case ",$ids," in *,claude,*workspaces,*|*,workspaces,*claude,*) pass "GET /api/state has claude + workspaces sources";; *) fail "GET /api/state sources" "got: $ids";; esac
else fail "GET /api/state" "http $CODE"; fi

get /api/plugins
if [ "$CODE" = 200 ]; then
  errs="$(json 'JSON.stringify(j.errors ?? [])' 2>/dev/null || echo '?')"
  [ "$errs" = "[]" ] && pass "GET /api/plugins errors == []" || fail "GET /api/plugins errors" "$errs"
  bad="$(json '(j.plugins ?? j).filter(p => !["active","disabled"].includes(p.state ?? p.status)).map(p => p.id+":"+(p.state ?? p.status)).join(" ")' 2>/dev/null || echo '?')"
  [ -z "$bad" ] && pass "every plugin is active or disabled" || fail "plugin states" "$bad"
else fail "GET /api/plugins" "http $CODE"; fi

code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$BASE/api/status")"
[ "$code" = 403 ] && pass "foreign Host -> 403" || fail "foreign Host" "http $code"

# terminals plugin daemon
SOCK="$WORK_HUB_STATE_DIR/termd.sock"
for _ in $(seq 1 20); do [ -S "$SOCK" ] && break; sleep 0.5; done
if [ -S "$SOCK" ]; then
  DAEMON_PID="$(sed -n 's/.*terminal daemon (pid \([0-9]*\)).*/\1/p' "$TMP/server.log" | head -1)"
  pass "terminals daemon autostarted on termd.sock (pid ${DAEMON_PID:-?})"
else
  echo "INFO  no daemon (termd.sock absent; autostart off or terminals plugin disabled)"
fi

echo
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) FAILED"; tail -20 "$TMP/server.log"; exit 1; fi
echo "all checks passed"
