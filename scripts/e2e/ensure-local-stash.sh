#!/usr/bin/env bash
# Starts (or reuses) a local trail-stash instance for network-segmentation/chaos testing, so
# those tests never touch production infra. Formalizes the manual "clone trail-stash, cargo run
# it, point .env.local at it" workflow used to validate cb39f47's durable-delivery receipt path
# into a repeatable script, against trail-stash's real `bin/trail-stash.rs` interface: required
# `TRAIL_STASH_SECRET_KEY`, `TRAIL_STASH_PRINT_TICKET=1` to have it print its own dial ticket, and
# `GET /healthz` for readiness.
#
# Usage:
#   scripts/e2e/ensure-local-stash.sh start   # build + start (or reuse) the local stash; prints
#                                              # connection info and the .env.local lines to add
#   scripts/e2e/ensure-local-stash.sh status  # print whether it's running + its connection info
#   scripts/e2e/ensure-local-stash.sh stop    # stop it (SIGTERM, waits for clean shutdown)
#
# The stash's identity (TRAIL_STASH_SECRET_KEY) and control-API PSK are generated once and
# persisted in the state dir, so its dial ticket is stable across restarts — chaos scenarios and
# any stash-only friend observers paired against it don't need to re-pair every run.
#
# Does NOT write .env.local itself — this repo has no precedent for a script mutating a
# developer's env file, and EXPO_PUBLIC_* values are inlined at bundle time anyway (see
# AGENTS.md), so a chaos-testing build already requires a deliberate rebuild step. Prints the
# exact lines to add instead.
#
# Env:
#   TRAIL_STASH_REPO       — path to a local github.com/unrealJune/trail-stash checkout.
#                             Default: ~/trail-stash
#   TRAIL_STASH_LOCAL_PORT — control-API port. Default: 8799 (deliberately NOT trail-stash's own
#                             8787 default, so a real local deployment and this one never collide).
set -euo pipefail

STATE_DIR="${TRAIL_STASH_LOCAL_STATE_DIR:-$HOME/Library/Application Support/streetcryptid/e2e-local-stash}"
REPO="${TRAIL_STASH_REPO:-$HOME/trail-stash}"
PORT="${TRAIL_STASH_LOCAL_PORT:-8799}"
HEALTH_TIMEOUT_SECONDS=30

log() { echo "[ensure-local-stash] $*" >&2; }

command -v cargo >/dev/null 2>&1 || {
  echo "error: cargo not found on PATH" >&2
  exit 1
}
command -v curl >/dev/null 2>&1 || {
  echo "error: curl not found on PATH" >&2
  exit 1
}

[ -f "$REPO/rust/Cargo.toml" ] || {
  echo "error: no trail-stash checkout at $REPO (expected $REPO/rust/Cargo.toml)" >&2
  echo "       clone it: git clone https://github.com/unrealJune/trail-stash \"$REPO\"" >&2
  echo "       or set TRAIL_STASH_REPO to point at an existing checkout" >&2
  exit 1
}

mkdir -p "$STATE_DIR"
SECRET_FILE="$STATE_DIR/secret_key"
PSK_FILE="$STATE_DIR/psk"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/stash.log"
TICKET_FILE="$STATE_DIR/ticket"

is_running() {
  [ -f "$PID_FILE" ] || return 1
  kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

is_healthy() {
  curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null | grep -q '^200$'
}

print_connection_info() {
  local psk ticket
  psk="$(cat "$PSK_FILE")"
  ticket="$(cat "$TICKET_FILE" 2>/dev/null || echo '(unknown — see stash.log)')"
  cat >&2 <<EOF

Local trail-stash is up on http://127.0.0.1:$PORT (reachable from iOS Simulators — they share
the host's network stack; NOT reachable from a physical device or an Android emulator, which
need the host's LAN IP the way infra/otel/README.md's OTEL setup does).

Add to .env.local for a harness build that targets it, then rebuild (bunx expo run:ios):
  EXPO_PUBLIC_TRAIL_STASH_URL=http://127.0.0.1:$PORT
  EXPO_PUBLIC_TRAIL_STASH_TICKET=$ticket
  EXPO_PUBLIC_TRAIL_STASH_PSK=$psk

State dir (identity persists here across restarts): $STATE_DIR
Log: $LOG_FILE
EOF
}

cmd_status() {
  if is_running && is_healthy; then
    log "running (pid $(cat "$PID_FILE"), healthy)"
    print_connection_info
    return 0
  fi
  log "not running"
  return 1
}

cmd_stop() {
  if is_running; then
    local pid
    pid="$(cat "$PID_FILE")"
    log "stopping (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
  log "stopped"
}

cmd_start() {
  if is_running && is_healthy; then
    log "already running and healthy"
    print_connection_info
    return 0
  fi
  # A pid file pointing at a dead/unhealthy process — clear it before starting fresh.
  if [ -f "$PID_FILE" ] && ! is_running; then
    rm -f "$PID_FILE"
  fi

  [ -f "$SECRET_FILE" ] || openssl rand -hex 32 >"$SECRET_FILE"
  [ -f "$PSK_FILE" ] || openssl rand -hex 32 >"$PSK_FILE"

  log "building (cargo build --features live)"
  cargo build --features live --manifest-path "$REPO/rust/Cargo.toml" --quiet

  log "starting on port $PORT"
  : >"$LOG_FILE"
  TRAIL_STASH_SECRET_KEY="$(cat "$SECRET_FILE")" \
    TRAIL_STASH_PSK="$(cat "$PSK_FILE")" \
    TRAIL_STASH_PRINT_TICKET=1 \
    PORT="$PORT" \
    nohup "$REPO/rust/target/debug/trail-stash" >"$LOG_FILE" 2>&1 &
  echo "$!" >"$PID_FILE"

  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if is_healthy; then
      grep -o 'TRAIL_STASH_TICKET=.*' "$LOG_FILE" | head -1 | cut -d= -f2- >"$TICKET_FILE"
      log "healthy"
      print_connection_info
      return 0
    fi
    if ! is_running; then
      log "process exited before becoming healthy — see $LOG_FILE"
      tail -20 "$LOG_FILE" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  log "did not become healthy within ${HEALTH_TIMEOUT_SECONDS}s — see $LOG_FILE"
  tail -20 "$LOG_FILE" >&2
  exit 1
}

case "${1:-start}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  *)
    echo "usage: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac
