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
#   GRAFANA_ADDR        tailnet IP to pin the hostname to when proxying (default 100.89.102.169)
#   SC_TELEMETRY_PROXY  e.g. socks5://127.0.0.1:1055; unset = connect directly

GRAFANA_URL="${GRAFANA_URL:-https://grafana.delphinium.junephilip.com}"
GRAFANA_ADDR="${GRAFANA_ADDR:-100.89.102.169}"

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
    _host=$(printf '%s' "$GRAFANA_URL" | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##')
    # An explicit --proxy overrides the sandbox's HTTPS_PROXY, and --resolve keeps the lookup
    # local, so tailscaled is handed the tailnet IP rather than asked to resolve anything.
    curl -s --max-time 60 --proxy "$SC_TELEMETRY_PROXY" --resolve "$_host:443:$GRAFANA_ADDR" \
      -H "Authorization: Bearer $GRAFANA_TOKEN" "$@" "$GRAFANA_URL$_path"
  else
    curl -s --max-time 60 -H "Authorization: Bearer $GRAFANA_TOKEN" "$@" "$GRAFANA_URL$_path"
  fi
}
