#!/usr/bin/env bash

# Exercise a built `streetcryptid-repeater` end to end as an unprivileged user, the way a person
# would: run the daemon, manage it over its socket, stop it, start it again.
#
#   repeater/linux/scripts/test-daemon.sh target/desktop-release/streetcryptid-repeater
#
# Needs the network (the node binds a real iroh endpoint). Touches nothing outside a temporary
# directory.

set -euo pipefail

bin="$(realpath "${1:?usage: $0 <streetcryptid-repeater binary>}")"
work="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-repeater-test.XXXXXX")"
state="$work/state"
socket="$work/control.sock"
pid=''

cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [[ -f "$work/daemon.log" ]]; then
    echo "--- daemon output ---" >&2
    # The claim link is a secret even in a test; it must not be in here, and is not printed.
    sed 's#streetcrypt.id/repeater\#.*#<claim link>#' "$work/daemon.log" >&2
  fi
  exit 1
}

cli() {
  "$bin" "$@" --socket "$socket"
}

start_daemon() {
  # Not a terminal: stdout is a file, as under systemd, so the claim QR must not be printed.
  "$bin" run --state-dir "$state" --socket "$socket" >> "$work/daemon.log" 2>&1 &
  pid=$!
  for _ in $(seq 90); do
    if cli status --json > "$work/status.json" 2>/dev/null; then
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || fail "the daemon exited while starting"
    sleep 1
  done
  fail "the daemon did not answer within 90 s"
}

stop_daemon() {
  kill -TERM "$pid"
  wait "$pid" || fail "the daemon did not exit cleanly on SIGTERM"
  pid=''
}

field() {
  sed -n "s/^  \"$1\": \(.*\),\{0,1\}$/\1/p" "$work/status.json" | sed 's/,$//'
}

echo "== first start"
start_daemon
[[ "$(field claimed)" == false ]] || fail "a fresh repeater reports itself claimed"
endpoint="$(field endpointId)"
[[ ${#endpoint} -eq 66 ]] || fail "unexpected endpoint id $endpoint"
[[ "$(stat -c %a "$socket")" == 600 ]] || fail "the user socket is not owner-only"
[[ "$(stat -c %a "$state")" == 700 ]] || fail "the state directory is not private"
[[ "$(stat -c %a "$state/secret.key")" == 600 ]] || fail "the identity is not owner-only"

echo "== status reads like the app"
cli status | grep -q 'unclaimed' || fail "status does not say it is unclaimed"

echo "== claim"
link="$(cli claim --once --link)"
[[ "$link" == https://streetcrypt.id/repeater/claim#t=*\&s=* ]] || fail "claim did not print a claim link"
cli claim --once | grep -q 'scan this with your phone' || fail "claim did not show the QR text"
grep -q 'streetcrypt.id/repeater' "$work/daemon.log" && fail "the claim link reached the daemon's log"
grep -q 'claim' "$work/daemon.log" || fail "the log does not point at the claim command"

echo "== settings"
cli settings | grep -q 'keep-awake   off' || fail "settings do not start off"
cli settings --keep-awake on | grep -q 'Saved' || fail "settings were not saved"
cli status --json > "$work/status.json"
grep -q '"keepAwake": true' "$work/status.json" || fail "the snapshot does not carry the new setting"
grep -q '"keepAwake":true' "$state/host-settings.json" || fail "the setting was not persisted"

echo "== name and release"
cli name | grep -q '(no name)' || fail "a new repeater has a name"
cli name 'Test   box' | grep -q 'Named "Test box"' || fail "the name was not saved tidied"
cli status | grep -q 'Name         Test box' || fail "status does not show the name"
[[ "$(cat "$state/repeater-name.txt")" == 'Test box' ]] || fail "the name was not persisted"
cli name "$(printf 'x%.0s' {1..41})" 2>/dev/null && fail "a 41-character name was accepted"
cli name --clear | grep -q 'cleared' || fail "the name was not cleared"
[[ -e "$state/repeater-name.txt" ]] && fail "a cleared name stayed on disk"
cli release | grep -q 'not claimed' || fail "releasing an unclaimed repeater did something"

echo "== a malformed command is refused"
if command -v python3 >/dev/null; then
  python3 - "$socket" <<'EOF' || fail "a client sending garbage was not disconnected"
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.connect(sys.argv[1])
s.settimeout(10)
s.sendall(b'{"protocol":2,"kind":"claim"}\n')
data = b""
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    data += chunk
EOF
fi

echo "== watch"
timeout 5 "$bin" watch --socket "$socket" > "$work/watch.log" || true
head -1 "$work/watch.log" | grep -q '"kind":"service"' || fail "watch did not start with the service line"
grep -q '"kind":"snapshot"' "$work/watch.log" || fail "watch saw no snapshot"

echo "== only one daemon per state directory"
if "$bin" run --state-dir "$state" --socket "$work/other.sock" > "$work/second.log" 2>&1; then
  fail "a second daemon started on the same state"
fi
grep -q 'already running' "$work/second.log" || fail "the second daemon did not say why"

echo "== SIGTERM stops it and removes the socket"
stop_daemon
[[ ! -e "$socket" ]] || fail "the socket was left behind"

echo "== a restart is the same repeater, with the same settings"
start_daemon
[[ "$(field endpointId)" == "$endpoint" ]] || fail "the identity changed across a restart"
grep -q '"keepAwake": true' "$work/status.json" || fail "the setting did not survive a restart"
stop_daemon

echo "== a per-user daemon refuses a directory whose identity moved to the service"
touch "$state/moved-to-service"
if "$bin" run --state-dir "$state" --socket "$socket" > "$work/moved.log" 2>&1; then
  fail "the daemon started on a moved identity"
fi
grep -q 'system service' "$work/moved.log" || fail "the refusal did not say why"

echo "== no repeater running"
if "$bin" status --socket "$socket" > /dev/null 2>"$work/none.log"; then
  fail "status succeeded with nothing running"
fi
grep -q 'No repeater is running' "$work/none.log" || fail "status did not say nothing is running"

echo "The Linux repeater daemon passed every check."
