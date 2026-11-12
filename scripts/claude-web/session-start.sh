#!/bin/bash
# SessionStart hook: give a Claude Code web (cloud) session a route to Grafana.
#
# Grafana is tailnet-only and a cloud sandbox has no TUN device, so this joins the tailnet in
# userspace mode as an EPHEMERAL node (state in memory, gone with the sandbox) and exposes a
# SOCKS5 listener that scripts/telemetry/*.sh route through. Everywhere else it does nothing.
#
# Needs, in the cloud environment's settings:
#   TS_AUTHKEY     ephemeral, pre-authorized auth key tagged tag:claude-web
#   GRAFANA_URL    Grafana base URL
#   GRAFANA_TOKEN  Viewer service-account token
#   GRAFANA_ADDR   (optional) Grafana's tailnet IP, to skip name resolution over the tailnet
# and network access to pkgs.tailscale.com and *.tailscale.com (control plane + DERP). UDP does
# not leave the sandbox, so every packet rides DERP over 443.
set -u

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
if [ -z "${TS_AUTHKEY:-}" ]; then
  echo "claude-web: TS_AUTHKEY not set; scripts/telemetry will not reach Grafana."
  exit 0
fi

SOCKS=127.0.0.1:1055
DIR="$HOME/.local/tailscale"
SOCK="$DIR/tailscaled.sock"
LOG="$DIR/tailscaled.log"
mkdir -p "$DIR"

if [ ! -x "$DIR/tailscaled" ]; then
  case "$(uname -m)" in aarch64 | arm64) ARCH=arm64 ;; *) ARCH=amd64 ;; esac
  TGZ=$(curl -fsSL --max-time 20 "https://pkgs.tailscale.com/stable/?mode=json" |
    sed -n "s/.*\"$ARCH\": *\"\(tailscale_[^\"]*\.tgz\)\".*/\1/p" | head -n1)
  if [ -z "$TGZ" ]; then
    echo "claude-web: could not resolve a Tailscale release (is pkgs.tailscale.com allowed?)"
    exit 0
  fi
  if ! curl -fsSL --max-time 60 "https://pkgs.tailscale.com/stable/$TGZ" |
    tar -xz -C "$DIR" --strip-components=1; then
    echo "claude-web: Tailscale download failed"
    exit 0
  fi
fi

if ! "$DIR/tailscale" --socket="$SOCK" status >/dev/null 2>&1; then
  # tailscaled honours HTTPS_PROXY, which is the only way control and DERP leave the sandbox.
  nohup "$DIR/tailscaled" --tun=userspace-networking --state=mem: --socket="$SOCK" \
    --socks5-server="$SOCKS" --no-logs-no-support >"$LOG" 2>&1 &
  for _ in $(seq 1 50); do
    [ -S "$SOCK" ] && break
    sleep 0.2
  done
  # The key goes in by file, not argv, so it never shows up in `ps`.
  KEYFILE="$DIR/authkey"
  (umask 077 && printf '%s' "$TS_AUTHKEY" >"$KEYFILE")
  timeout 45 "$DIR/tailscale" --socket="$SOCK" up --auth-key="file:$KEYFILE" \
    --hostname="claude-web-$(hostname | cut -c1-12)" --accept-dns=false >>"$LOG" 2>&1
  UP=$?
  rm -f "$KEYFILE"
  if [ "$UP" -ne 0 ]; then
    echo "claude-web: tailscale up failed; see $LOG"
    exit 0
  fi
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export SC_TELEMETRY_PROXY=socks5://$SOCKS" >>"$CLAUDE_ENV_FILE"
fi
echo "claude-web: on the tailnet; scripts/telemetry/{tq,tr,lq}.sh reach Grafana via socks5://$SOCKS"
