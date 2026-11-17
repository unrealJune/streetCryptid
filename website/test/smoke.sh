#!/usr/bin/env bash

# Smoke-test a running streetcrypt.id image: every path the phones, the verifiers and the guide
# depend on, with the status and content type each must have. CI runs it against the image it just
# built; point it at production to check a deploy.
#
#   bash website/test/smoke.sh http://localhost:8080
#   bash website/test/smoke.sh https://streetcrypt.id

set -euo pipefail

base="${1:?usage: smoke.sh <base-url>}"
failed=0

# path, status, content type (prefix match)
check() {
  local path="$1" want_status="$2" want_type="$3" got
  got="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "${base}${path}")"
  local status="${got%% *}" type="${got#* }"
  if [[ "$status" != "$want_status" || "$type" != "$want_type"* ]]; then
    printf 'FAIL %s: want %s %s, got %s %s\n' "$path" "$want_status" "$want_type" "$status" "$type" >&2
    failed=1
  else
    printf 'ok   %s %s %s\n' "$path" "$status" "$type"
  fi
}

# The association files: application/json and never a redirect, or verification fails silently.
check /.well-known/apple-app-site-association 200 application/json
check /.well-known/assetlinks.json 200 application/json
# Invites and claims ride in the fragment; a trailing-slash redirect is one more chance to lose it.
check /pair 200 text/html
check /pair/ 200 text/html
check /repeater 200 text/html
check /repeater/ 200 text/html
check /repeater/claim 200 text/html
check /repeater/claim/ 200 text/html
# `irm … | iex` needs a text type, or iex is handed bytes.
check /repeater/install.ps1 200 text/plain
check /repeater/guide.js 200 text/javascript
check / 200 text/html
check /style.css 200 text/css
check /field.js 200 text/javascript
check /fonts/rajdhani-400.woff2 200 font/woff2
check /no-such-page 404 text/html

exit "$failed"
