#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL=com.anyways.controller
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$ROOT/.env"
LOG_DIR="${LOG_DIRECTORY:-$HOME/Library/Logs/AnywaysController}"
NODE_BIN="$(command -v node)"
CODEX_BIN=""

read_codex_bin() {
  CODEX_BIN="$(awk -F= '$1 == "ANYWAYS_CODEX_BIN" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  [ -n "$CODEX_BIN" ] || { echo "ANYWAYS_CODEX_BIN is required in $ENV_FILE." >&2; return 1; }
  case "$CODEX_BIN" in /*) ;; *) echo "ANYWAYS_CODEX_BIN must be an absolute path." >&2; return 1 ;; esac
  [ -f "$CODEX_BIN" ] || { echo "Configured Codex executable does not exist: $CODEX_BIN" >&2; return 1; }
  [ -x "$CODEX_BIN" ] || { echo "Configured Codex executable is not executable: $CODEX_BIN" >&2; return 1; }
}

render_plist() {
  read_codex_bin
  sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__CONTROLLER__|$ROOT|g" -e "s|__LOG_DIR__|$LOG_DIR|g" "$ROOT/launchd/com.anyways.controller.plist.template" > "$PLIST"
  /usr/bin/plutil -replace EnvironmentVariables.ANYWAYS_CODEX_BIN -string "$CODEX_BIN" "$PLIST"
}

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

service_pid() {
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | awk '$1 == "pid" && $2 == "=" { print $3; exit }'
}

listener_pids() {
  lsof -nP -t -iTCP:4317 -sTCP:LISTEN 2>/dev/null || true
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

wait_for_exit() {
  local pid="$1" deadline=$((SECONDS + 30))
  while pid_alive "$pid"; do
    [ "$SECONDS" -lt "$deadline" ] || { echo "Controller PID $pid did not exit." >&2; return 1; }
    sleep 0.2
  done
}

wait_for_listener_exit() {
  local expected_pid="${1:-}" deadline=$((SECONDS + 30)) current
  while true; do
    current="$(listener_pids)"
    if [ -z "$current" ]; then return 0; fi
    if [ -n "$expected_pid" ] && printf '%s\n' "$current" | grep -vxF "$expected_pid" >/dev/null; then
      echo "Port 4317 is owned by an unexpected process: $current" >&2
      return 1
    fi
    [ "$SECONDS" -lt "$deadline" ] || { echo "Port 4317 did not become free." >&2; return 1; }
    sleep 0.2
  done
}

wait_for_started_listener() {
  local deadline=$((SECONDS + 30)) pid listener
  while [ "$SECONDS" -lt "$deadline" ]; do
    pid="$(service_pid || true)"
    listener="$(listener_pids)"
    if [ -n "$pid" ] && [ "$listener" = "$pid" ]; then
      echo "$pid"
      return 0
    fi
    if [ -n "$listener" ] && [ -n "$pid" ] && [ "$listener" != "$pid" ]; then
      echo "LaunchAgent PID $pid does not own port 4317; listener owner is $listener." >&2
      return 1
    fi
    sleep 0.2
  done
  echo "Controller did not acquire port 4317 within 30 seconds." >&2
  return 1
}

stop_loaded_service() {
  local old_pid="${1:-}" listener
  listener="$(listener_pids)"
  if [ -n "$listener" ] && [ -z "$old_pid" ]; then
    echo "Refusing to stop: port 4317 is owned by unmanaged process PID $listener." >&2
    return 1
  fi
  if [ -n "$listener" ] && [ -n "$old_pid" ] && [ "$listener" != "$old_pid" ]; then
    echo "Refusing to stop: port 4317 is owned by PID $listener, not LaunchAgent PID $old_pid." >&2
    return 1
  fi
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  [ -z "$old_pid" ] || wait_for_exit "$old_pid"
  wait_for_listener_exit "$old_pid"
}

bootstrap_service() {
  launchctl bootstrap "$DOMAIN" "$PLIST"
  wait_for_started_listener >/dev/null
  echo "started"
}

case "${1:-}" in
  install)
    test -f "$ENV_FILE" || { echo "Create protected $ENV_FILE from .env.example first."; exit 1; }
    render_plist
    launchctl bootstrap "$DOMAIN" "$PLIST"
    wait_for_started_listener >/dev/null
    echo "installed";;
  start)
    render_plist
    if [ -n "$(listener_pids)" ]; then echo "Port 4317 is already owned; use restart only through this LaunchAgent." >&2; exit 1; fi
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then echo "LaunchAgent is already loaded; refusing a second start." >&2; exit 1; fi
    bootstrap_service;;
  stop)
    stop_loaded_service "$(service_pid || true)"; echo "stopped";;
  restart)
    old_pid="$(service_pid || true)"
    stop_loaded_service "$old_pid"
    render_plist
    bootstrap_service;;
  status) launchctl print "$DOMAIN/$LABEL";;
  uninstall)
    stop_loaded_service "$(service_pid || true)" || true
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST";;
  tail) tail -f "$LOG_DIR/controller.log";;
  *) echo "Usage: $0 {install|start|restart|status|uninstall|tail}"; exit 1;;
esac
