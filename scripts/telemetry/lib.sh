#!/bin/sh
# Shared plumbing for the telemetry query helpers (tq.sh / tr.sh / lq.sh).
#
# Grafana resolves publicly but routes only over the tailnet (100.x). On a laptop that is
# Tailscale's job and these helpers just curl. In a Claude Code web session there is no tailnet
# interface: scripts/claude-web/session-start.sh joins one in userspace mode and exports
# SC_TELEMETRY_PROXY (tailscaled's SOCKS5 listener), and every request is pinned through it.
#
#   GRAFANA_URL         Grafana base URL; falls back to ~/.config/streetcryptid/grafana-url
#   GRAFANA_TOKEN       Viewer service-account token; falls back to ~/.config/streetcryptid/grafana-token
#   GRAFANA_ADDR        tailnet IP to pin the hostname to when proxying; unset = tailscaled resolves
#   SC_TELEMETRY_PROXY  e.g. socks5://127.0.0.1:1055; unset = connect directly
#
# None of these have defaults: the repo is public, and the host and token stay out of it.

sc_setting() { # sc_setting <var> <file>
  eval "_v=\${$1:-}"
  if [ -z "$_v" ] && [ -r "$HOME/.config/streetcryptid/$2" ]; then
    _v=$(cat "$HOME/.config/streetcryptid/$2")
  fi
  if [ -z "$_v" ]; then
    echo "telemetry: set $1 or write ~/.config/streetcryptid/$2" >&2
    exit 2
  fi
  eval "$1=\$_v"
}
sc_setting GRAFANA_URL grafana-url
sc_setting GRAFANA_TOKEN grafana-token

# grafana_curl <path> [curl args...]
grafana_curl() {
  _path="$1"; shift
  set -- -s --max-time 60 "$@"
  if [ -n "${SC_TELEMETRY_PROXY:-}" ]; then
    # An explicit --proxy overrides the sandbox's HTTPS_PROXY. With GRAFANA_ADDR the lookup stays
    # local (--resolve) and tailscaled is handed the tailnet IP; without it, socks5h lets
    # tailscaled resolve the name.
    if [ -n "${GRAFANA_ADDR:-}" ]; then
      _host=$(printf '%s' "$GRAFANA_URL" | sed -e 's#^[a-z]*://##' -e 's#[/:].*$##')
      set -- --proxy "$SC_TELEMETRY_PROXY" --resolve "$_host:443:$GRAFANA_ADDR" "$@"
    else
      set -- --proxy "$(printf '%s' "$SC_TELEMETRY_PROXY" | sed 's#^socks5://#socks5h://#')" "$@"
    fi
  fi
  # The header goes in on stdin, not argv, so the token never shows up in `ps`.
  printf 'header = "Authorization: Bearer %s"\n' "$GRAFANA_TOKEN" |
    curl --config - "$@" "$GRAFANA_URL$_path"
}
