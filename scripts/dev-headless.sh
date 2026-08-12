#!/bin/bash
# Start/stop Agetor's backend + frontend without the Electrobun GUI shell.
#
# Use this on a box with no display (SSH/headless server) — access the UI
# from your local machine through an SSH tunnel:
#   ssh -L 5173:localhost:5173 -L 4318:localhost:4318 <user>@<host>
# then open the URL this script prints.
#
# Usage: scripts/dev-headless.sh [start|stop|restart|status] [--force]
#   start (default) — start backend + vite if not already running
#   stop             — stop both
#   restart          — stop then start
#   status           — report whether they're running, with the access URL
#   --force          — with start/restart, kill whatever else holds the API
#                       port even if this script didn't start it
#
# Env overrides: AGETOR_DATA_DIR, AGETOR_API_PORT, AGETOR_API_TOKEN.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${AGETOR_DATA_DIR:-$HOME/.agetor-dev}"
API_PORT="${AGETOR_API_PORT:-4318}"
VITE_PORT=5173
RUN_DIR="$DATA_DIR/headless-dev"
BACKEND_PID_FILE="$RUN_DIR/backend.pid"
VITE_PID_FILE="$RUN_DIR/vite.pid"
TOKEN_FILE="$RUN_DIR/token"
BACKEND_LOG="$RUN_DIR/backend.log"
VITE_LOG="$RUN_DIR/vite.log"

red() { printf '\033[31m%s\033[0m\n' "$1"; }
grn() { printf '\033[32m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

ACTION="start"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    start|stop|restart|status) ACTION="$arg" ;;
    --force) FORCE=1 ;;
    *) red "unknown argument: $arg"; exit 1 ;;
  esac
done

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

# Resolve the persisted theme preference the same way the packaged app's
# boot path does, so the URL this script prints carries `&theme=<pref>` and
# the browser-driven (Playwright) path actually exercises the boot-theme
# channel it exists to guard — see docs/plans/auto-dark-light-theme.md §3 D1
# and src/bun/window-url.ts's resolveThemePreference/buildWindowHash. There
# is no Bun-side entry point importable from a shell script other than
# spawning `bun` itself, so this shells out to a one-off `bun -e` that
# imports window-url.ts directly against the same AGETOR_DATA_DIR this
# script already uses — reusing the real resolution logic (including its
# fallback-to-"auto" on a DB error) rather than re-deriving it here. Bun's
# migration-log line (and anything else module-load prints to stdout) is
# swallowed by `2>/dev/null | tail -n1`, keeping only the last line, which is
# always the bare theme string written via `process.stdout.write`. Falls
# back to "auto" if the bun invocation fails for any reason (e.g. bun not on
# PATH in a stripped-down shell) — matching resolveThemePreference's own
# default and never blocking the script on a theme lookup.
resolve_theme() {
  local theme
  theme="$(cd "$REPO_ROOT" && AGETOR_DATA_DIR="$DATA_DIR" bun -e '
    import("./src/bun/window-url.ts").then((m) => {
      process.stdout.write(m.resolveThemePreference());
    });
  ' 2>/dev/null | tail -n1)"
  case "$theme" in
    dark|light|auto) echo "$theme" ;;
    *) echo "auto" ;;
  esac
}

# Same idea as resolve_theme above, for the `fontSize` boot channel
# (src/bun/window-url.ts's resolveFontSizePreference) — without this the
# browser-driven (Playwright) path would boot at the default 100% regardless
# of what's persisted, showing a size-jump flash once main.tsx's React tree
# reconciles the real preference. Falls back to 100 (FONT_SIZE_DEFAULT) on
# any failure, matching resolveFontSizePreference's own default.
resolve_font_size() {
  local fs
  fs="$(cd "$REPO_ROOT" && AGETOR_DATA_DIR="$DATA_DIR" bun -e '
    import("./src/bun/window-url.ts").then((m) => {
      process.stdout.write(String(m.resolveFontSizePreference()));
    });
  ' 2>/dev/null | tail -n1)"
  case "$fs" in
    ''|*[!0-9]*) echo 100 ;;
    *) echo "$fs" ;;
  esac
}

read_pid_file() {
  [ -f "$1" ] && cat "$1" || true
}

# PID of whatever process (if any) is bound to $API_PORT on 127.0.0.1.
port_owner_pid() {
  ss -ltnp 2>/dev/null | awk -v p=":$API_PORT" '$4 ~ p"$" {print $NF}' \
    | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

stop_one() {
  local name="$1" pidfile="$2"
  local pid; pid="$(read_pid_file "$pidfile")"
  if pid_alive "$pid"; then
    dim "stopping $name (pid $pid)…"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      pid_alive "$pid" || break
      sleep 0.2
    done
    pid_alive "$pid" && kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
}

do_stop() {
  stop_one "backend" "$BACKEND_PID_FILE"
  stop_one "vite" "$VITE_PID_FILE"
  grn "stopped"
}

wait_for_health() {
  for _ in $(seq 1 50); do
    if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}

print_access_info() {
  local token="$1"
  local theme; theme="$(resolve_theme)"
  local fs; fs="$(resolve_font_size)"
  local font_size_param=""
  # Omit the param at the 100 default, matching buildWindowHash's own
  # omit-at-default rule (src/bun/window-url.ts) so this printed URL is
  # byte-identical to the pre-font-size shape for the common case.
  [ "$fs" != "100" ] && font_size_param="&fontSize=$fs"
  echo
  grn "agetor dev (headless) is up"
  echo "  backend:  http://127.0.0.1:$API_PORT  (log: $BACKEND_LOG)"
  echo "  frontend: http://127.0.0.1:$VITE_PORT  (log: $VITE_LOG)"
  echo
  echo "Open in a browser (tunnel both ports first if this is a remote host):"
  grn "  http://localhost:$VITE_PORT/#api=$API_PORT&token=$token&theme=$theme$font_size_param"
  echo
  dim "  curl -H \"Authorization: Bearer $token\" http://127.0.0.1:$API_PORT/tasks"
  echo
  dim "stop with: $0 stop"
}

do_status() {
  local backend_pid vite_pid
  backend_pid="$(read_pid_file "$BACKEND_PID_FILE")"
  vite_pid="$(read_pid_file "$VITE_PID_FILE")"
  if pid_alive "$backend_pid" && pid_alive "$vite_pid"; then
    print_access_info "$(cat "$TOKEN_FILE" 2>/dev/null || echo '?')"
  else
    red "not running (start with: $0 start)"
    exit 1
  fi
}

do_start() {
  mkdir -p "$RUN_DIR"

  local backend_pid vite_pid
  backend_pid="$(read_pid_file "$BACKEND_PID_FILE")"
  vite_pid="$(read_pid_file "$VITE_PID_FILE")"
  if pid_alive "$backend_pid" && pid_alive "$vite_pid"; then
    dim "already running"
    print_access_info "$(cat "$TOKEN_FILE" 2>/dev/null || echo '?')"
    return 0
  fi

  # A dangling pidfile (e.g. from a crash) with a dead pid — clean it up
  # before touching the port so we don't mistake a stale record for a
  # conflict below.
  pid_alive "$backend_pid" || rm -f "$BACKEND_PID_FILE"
  pid_alive "$vite_pid" || rm -f "$VITE_PID_FILE"

  local owner
  owner="$(port_owner_pid || true)"
  if [ -n "$owner" ]; then
    if [ "$FORCE" = 1 ]; then
      dim "port $API_PORT held by pid $owner — killing it (--force)…"
      kill "$owner" 2>/dev/null || true
      sleep 1
    else
      red "port $API_PORT is already in use by pid $owner (not something this script started)."
      echo "  Inspect it with: ps -p $owner -o pid,cmd"
      echo "  Then either stop it yourself, or re-run with --force to kill it."
      exit 1
    fi
  fi

  local token="${AGETOR_API_TOKEN:-}"
  if [ -z "$token" ]; then
    if [ -f "$TOKEN_FILE" ]; then
      token="$(cat "$TOKEN_FILE")"
    else
      token="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
  fi
  echo "$token" > "$TOKEN_FILE"

  cd "$REPO_ROOT"

  dim "starting vite on $VITE_PORT…"
  AGETOR_DATA_DIR="$DATA_DIR" \
    nohup bun run hmr > "$VITE_LOG" 2>&1 &
  echo $! > "$VITE_PID_FILE"

  dim "starting headless backend on $API_PORT…"
  AGETOR_DATA_DIR="$DATA_DIR" AGETOR_API_PORT="$API_PORT" AGETOR_API_TOKEN="$token" \
    nohup bun run src/bun/headless.ts > "$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID_FILE"

  if ! wait_for_health; then
    red "backend never became healthy — tail of $BACKEND_LOG:"
    tail -n 30 "$BACKEND_LOG" || true
    do_stop
    exit 1
  fi

  print_access_info "$token"
}

case "$ACTION" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; do_start ;;
  status) do_status ;;
esac
