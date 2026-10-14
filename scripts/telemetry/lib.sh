#!/bin/sh
# Shared plumbing for the telemetry query helpers (tq.sh / tr.sh / lq.sh).
#
# Grafana resolves publicly but routes only over the tailnet (100.x). On a laptop that is
# Tailscale's job and these helpers just curl. In a Claude Code web session there is no tailnet
# interface: scripts/claude-web/session-start.sh joins one in userspace mode and exports
# SC_TELEMETRY_PROXY (tailscaled's SOCKS5 listener), and every request is pinned through it.
#
#   GRAFANA_URL         default https://grafana.delphinium.junephilip.com
#   GRAFANA_TOKEN       Viewer service-account token; falls back to ~/.config/streetcryptid/grafana-token
#   GRAFANA_ADDR        tailnet IP to pin the hostname to when proxying. Unset = looked up from
#                       `tailscale status` (the node named "grafana"); tailnet IPs change when a
#                       node re-registers, so none is hardcoded here. To find it by hand:
#                         ~/.local/tailscale/tailscale --socket=~/.local/tailscale/tailscaled.sock status
#   SC_TELEMETRY_PROXY  e.g. socks5://127.0.0.1:1055; unset = connect directly

GRAFANA_URL="${GRAFANA_URL:-https://grafana.delphinium.junephilip.com}"

# tailnet_grafana_addr: the 100.x address of the tailnet node named "grafana", from the userspace
# tailscaled that scripts/claude-web/session-start.sh started. Prints nothing if it can't tell.
tailnet_grafana_addr() {
  _ts="$HOME/.local/tailscale"
  [ -x "$_ts/tailscale" ] || return 0
  "$_ts/tailscale" --socket="$_ts/tailscaled.sock" status 2>/dev/null |
    awk '$2 == "grafana" { print $1; exit }'
}

if [ -z "${GRAFANA_TOKEN:-}" ]; then
  if [ -r "$HOME/.config/streetcryptid/grafana-token" ]; then
    GRAFANA_TOKEN=$(cat "$HOME/.config/streetcryptid/grafana-token")
  else
    echo "telemetry: no GRAFANA_TOKEN and no ~/.config/streetcryptid/grafana-token" >&2
    exit 2
  fi
fi

# grafana_curl <path> [curl args...]
grafana_curl() {
  _path="$1"; shift
  if [ -n "${SC_TELEMETRY_PROXY:-}" ]; then
    GRAFANA_ADDR="${GRAFANA_ADDR:-$(tailnet_grafana_addr)}"
    if [ -z "$GRAFANA_ADDR" ]; then
      echo "telemetry: could not find a tailnet node named 'grafana'; set GRAFANA_ADDR (see lib.sh)" >&2
      return 2
    fi
    _host=$(printf '%s' "$GRAFANA_URL" | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##')
    # An explicit --proxy overrides the sandbox's HTTPS_PROXY, and --resolve keeps the lookup
    # local, so tailscaled is handed the tailnet IP rather than asked to resolve anything.
    curl -s --max-time 60 --proxy "$SC_TELEMETRY_PROXY" --resolve "$_host:443:$GRAFANA_ADDR" \
      -H "Authorization: Bearer $GRAFANA_TOKEN" "$@" "$GRAFANA_URL$_path"
  else
    curl -s --max-time 60 -H "Authorization: Bearer $GRAFANA_TOKEN" "$@" "$GRAFANA_URL$_path"
  fi
}
