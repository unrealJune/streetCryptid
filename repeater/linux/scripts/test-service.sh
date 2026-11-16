#!/usr/bin/env bash

# Install the real system service on THIS machine, use it, and remove it again: the Linux twin of
# repeater/windows/scripts/test-service.ps1. Run it only on a disposable machine (a CI runner, a
# throwaway VM or WSL distribution): it creates a system account, a unit and /var/lib state.
#
#   sudo repeater/linux/scripts/test-service.sh target/desktop-release/streetcryptid-repeater [person]
#
# `person` is an unprivileged account whose per-user identity is moved into the service and back
# (default: $SUDO_USER). The identity must come back byte-identical.

set -euo pipefail

[[ $EUID -eq 0 ]] || {
  echo "Run as root, on a disposable machine." >&2
  exit 2
}
[[ -d /run/systemd/system ]] || {
  echo "systemd is not running here." >&2
  exit 2
}

bin="$(realpath "${1:?usage: $0 <binary> [person]}")"
person="${2:-${SUDO_USER:-}}"
[[ -n "$person" && "$person" != root ]] || {
  echo "Name an unprivileged account (or run through sudo)." >&2
  exit 2
}
home="$(getent passwd "$person" | cut -d: -f6)"
user_state="$home/.local/state/streetcryptid/repeater"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# The person's daemon puts its socket here.
chown "$person" "$work"

fail() {
  echo "FAIL: $*" >&2
  for log in "$work"/*.log; do
    [[ -f "$log" ]] || continue
    echo "--- $(basename "$log")" >&2
    sed 's#streetcrypt.id/repeater\#.*#<claim link>#' "$log" >&2
  done
  journalctl -u streetcryptid-repeater --no-pager -n 50 2>/dev/null |
    sed 's#streetcrypt.id/repeater\#.*#<claim link>#' >&2 || true
  exit 1
}

# Not for a command run in the background: `$!` would be the function's subshell, and a signal
# to it would not reach the daemon.
as_person() {
  sudo -u "$person" -H env -u XDG_RUNTIME_DIR "$@"
}

echo "== a per-user identity to move"
sudo -u "$person" -H env -u XDG_RUNTIME_DIR "$bin" run --state-dir "$user_state" --socket "$work/user.sock" > "$work/user.log" 2>&1 &
pid=$!
for _ in $(seq 90); do
  [[ -f "$user_state/secret.key" ]] && as_person "$bin" status --socket "$work/user.sock" > /dev/null 2>&1 && break
  sleep 1
done
kill -TERM "$pid"
wait "$pid" || fail "the per-user daemon did not stop cleanly"
cp "$user_state/secret.key" "$work/identity"
chmod 0644 "$work/identity"

echo "== install --system moves it into the service"
SUDO_USER="$person" "$bin" install --system --keep-awake on < /dev/null > "$work/install.log" 2>&1 ||
  {
    cat "$work/install.log" >&2
    fail "install --system failed"
  }
systemctl is-active --quiet streetcryptid-repeater || fail "the service is not running"
[[ -f "$user_state/moved-to-service" ]] || fail "the per-user directory was not marked"
[[ ! -e "$user_state/secret.key" ]] || fail "the identity was copied, not moved"
cmp -s /var/lib/streetcryptid-repeater/secret.key "$work/identity" || fail "the service holds a different identity"
[[ "$(stat -c %U /var/lib/streetcryptid-repeater/secret.key)" == streetcryptid-repeater ]] ||
  fail "the identity does not belong to the service account"
[[ "$(stat -c %a /var/lib/streetcryptid-repeater)" == 700 ]] || fail "the service state is not private"
[[ "$(stat -c %a /run/streetcryptid-repeater/control.sock)" == 660 ]] || fail "the socket is not 0660"
id -nG "$person" | grep -qw streetcryptid-repeater || fail "$person was not made an administrator"
if [[ -d /etc/polkit-1/rules.d ]]; then
  [[ -f /etc/polkit-1/rules.d/50-streetcryptid-repeater.rules ]] || fail "the keep-awake polkit rule was not installed"
fi

echo "== root manages it over the system socket"
for _ in $(seq 60); do
  "$bin" status --json > "$work/status.json" 2>/dev/null && break
  sleep 1
done
grep -q '"mode": "service"' "$work/status.json" || fail "status did not reach the service"
grep -q '"keepAwake": true' "$work/status.json" || fail "install's settings were not applied"
"$bin" claim --once --link | grep -q '^https://streetcrypt.id/repeater/claim#' || fail "no claim link from the service"
journalctl -u streetcryptid-repeater --no-pager | grep -q 'streetcrypt.id/repeater' &&
  fail "the claim link reached the journal"

echo "== a group member manages it without sudo"
# sudo reads the person's groups afresh, as a new login would.
installed=/usr/local/lib/streetcryptid-repeater/streetcryptid-repeater
as_person "$installed" settings --telemetry off > "$work/member.log" 2>&1 || {
  cat "$work/member.log" >&2
  fail "a member of the group could not manage the service"
}

echo "== someone else cannot"
nobody_out="$(sudo -u nobody env -u XDG_RUNTIME_DIR HOME=/nonexistent "$installed" status 2>&1 || true)"
grep -q 'may not manage' <<<"$nobody_out" || fail "an outsider reached the socket: $nobody_out"

echo "== the per-user daemon refuses the moved directory"
if as_person "$bin" run --state-dir "$user_state" --socket "$work/user.sock" > "$work/refused.log" 2>&1; then
  fail "a per-user daemon started on a moved identity"
fi

echo "== re-running install updates in place"
SUDO_USER="$person" "$bin" install --system < /dev/null > /dev/null 2>&1 || fail "a second install failed"
systemctl is-active --quiet streetcryptid-repeater || fail "the service is not running after an update"

echo "== uninstall --system moves it back"
SUDO_USER="$person" "$bin" uninstall --system > "$work/uninstall.log" 2>&1 || {
  cat "$work/uninstall.log" >&2
  fail "uninstall --system failed"
}
systemctl list-unit-files streetcryptid-repeater.service --no-legend | grep -q . && fail "the unit is still installed"
[[ ! -e /etc/polkit-1/rules.d/50-streetcryptid-repeater.rules ]] || fail "the polkit rule was left behind"
cmp -s "$user_state/secret.key" "$work/identity" || fail "the identity did not come back byte-identical"
[[ "$(stat -c %U "$user_state/secret.key")" == "$person" ]] || fail "the identity did not go back to $person"
[[ ! -e "$user_state/moved-to-service" ]] || fail "the marker was left behind"
[[ ! -e /var/lib/streetcryptid-repeater/secret.key ]] || fail "the service kept a copy"

echo "== and it runs per user again"
sudo -u "$person" -H env -u XDG_RUNTIME_DIR "$bin" run --state-dir "$user_state" --socket "$work/user.sock" > "$work/again.log" 2>&1 &
pid=$!
for _ in $(seq 90); do
  as_person "$bin" status --socket "$work/user.sock" > /dev/null 2>&1 && break
  sleep 1
done
kill -TERM "$pid"
wait "$pid" || fail "the per-user daemon did not run again"

echo "The system service installed, moved the identity in and out, and came off cleanly."
