#!/usr/bin/env bash
# Network-reachability chaos helpers: block/restore traffic to one host:port via a dedicated pf
# anchor, so a scenario can prove the app survives (and recovers from) e.g. the stash going
# unreachable mid-share, without touching any other traffic on the machine or any production
# infra. Meant to be `source`d, not executed — matches lib/devices.sh's convention, including
# leaving `set -euo pipefail` to the caller (a `set` command here would silently change the
# caller's shell options too, since sourcing runs in the same shell).
#
# iOS Simulators share the host Mac's network stack — there is no per-simulator network
# namespace — so this necessarily blocks a host for the WHOLE machine, not one simulator. Fine
# for a single-device chaos scenario; not a way to build an asymmetric two-device partition
# (device A blocked, device B not) with what's available here. See
# scripts/e2e/scenarios/chaos-stash-unreachable.yaml.
#
# Needs sudo — pfctl is root-only, and every call here prompts for a password interactively the
# first time. Uses one dedicated anchor (CHAOS_ANCHOR) so it never touches any other pf rules;
# stop_chaos always flushes it and restores pf to whatever state start_chaos found it in.
#
# Usage:
#   source lib/netchaos.sh
#   start_chaos                          # enables pf if it wasn't already; remembers prior state
#   block_host 127.0.0.1 8799
#   ...
#   allow_host 127.0.0.1 8799            # or just stop_chaos to drop everything
#   stop_chaos                           # flushes the anchor, restores pf to its pre-start state

CHAOS_ANCHOR="com.streetcryptid.e2e-chaos"
CHAOS_RULES_FILE="$(mktemp -t streetcryptid-chaos-rules)"
CHAOS_HOSTS_BLOCKED=()   # "ip:port" strings currently blocked — source of truth for the rules file
CHAOS_PF_WAS_ENABLED=""  # "" = not yet determined, "1"/"0" once start_chaos has run

_chaos_require_pfctl() {
  command -v pfctl >/dev/null 2>&1 || {
    echo "error: pfctl not found (macOS only)" >&2
    return 1
  }
}

# _chaos_resolve_ip <host> — prints the first IPv4 address, or the host itself if it's already a
# dotted-quad (so "127.0.0.1", the common case for the local stash, never needs a resolver).
_chaos_resolve_ip() {
  local host="$1"
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s' "$host"
    return 0
  fi
  python3 -c "import socket,sys; print(socket.gethostbyname(sys.argv[1]))" "$host" 2>/dev/null
}

_chaos_write_rules() {
  : >"$CHAOS_RULES_FILE"
  local entry host port
  # `${arr[@]+"${arr[@]}"}`, not a bare `"${arr[@]}"`: bash 3.2 (macOS's stock /bin/bash, unlike
  # 4.4+) treats expanding an empty array under `set -u` as an unbound-variable error, and
  # CHAOS_HOSTS_BLOCKED is empty on every start_chaos call before the first block_host.
  for entry in ${CHAOS_HOSTS_BLOCKED[@]+"${CHAOS_HOSTS_BLOCKED[@]}"}; do
    host="${entry%%:*}"
    port="${entry##*:}"
    if [ "$port" = "*" ]; then
      echo "block drop quick proto {tcp udp} from any to $host" >>"$CHAOS_RULES_FILE"
    else
      echo "block drop quick proto {tcp udp} from any to $host port $port" >>"$CHAOS_RULES_FILE"
    fi
  done
  sudo pfctl -a "$CHAOS_ANCHOR" -f "$CHAOS_RULES_FILE" 2>&1 | grep -v '^pfctl: ' || true
}

# start_chaos — enables pf if needed (remembering whether it already was) and clears the anchor
# to empty. Call once per scenario run, before any block_host.
start_chaos() {
  _chaos_require_pfctl || return 1
  if sudo pfctl -s info 2>/dev/null | grep -q 'Status: Enabled'; then
    CHAOS_PF_WAS_ENABLED=1
  else
    CHAOS_PF_WAS_ENABLED=0
    sudo pfctl -e 2>&1 | grep -v '^pfctl: ' || true
  fi
  CHAOS_HOSTS_BLOCKED=()
  _chaos_write_rules
}

# block_host <host> [port] — port omitted blocks every port to that host.
block_host() {
  local host="$1" port="${2:-*}" ip
  ip="$(_chaos_resolve_ip "$host")"
  [ -n "$ip" ] || {
    echo "error: could not resolve $host" >&2
    return 1
  }
  CHAOS_HOSTS_BLOCKED+=("$ip:$port")
  _chaos_write_rules
  echo "[netchaos] blocked $host ($ip) port $port" >&2
}

# allow_host <host> [port] — removes one specific block (matched by resolved IP + port).
allow_host() {
  local host="$1" port="${2:-*}" ip target entry
  local kept=()
  ip="$(_chaos_resolve_ip "$host")"
  target="$ip:$port"
  # Same bash-3.2-empty-array note as _chaos_write_rules applies to both expansions below.
  for entry in ${CHAOS_HOSTS_BLOCKED[@]+"${CHAOS_HOSTS_BLOCKED[@]}"}; do
    [ "$entry" = "$target" ] || kept+=("$entry")
  done
  CHAOS_HOSTS_BLOCKED=(${kept[@]+"${kept[@]}"})
  _chaos_write_rules
  echo "[netchaos] restored $host ($ip) port $port" >&2
}

# stop_chaos — flushes the anchor and puts pf back exactly how start_chaos found it. Safe to call
# even if start_chaos was never called (idempotent, best-effort).
stop_chaos() {
  _chaos_require_pfctl || return 0
  CHAOS_HOSTS_BLOCKED=()
  sudo pfctl -a "$CHAOS_ANCHOR" -F all 2>&1 | grep -v '^pfctl: ' || true
  if [ "$CHAOS_PF_WAS_ENABLED" = "0" ]; then
    sudo pfctl -d 2>&1 | grep -v '^pfctl: ' || true
  fi
  rm -f "$CHAOS_RULES_FILE"
}
