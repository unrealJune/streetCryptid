#!/usr/bin/env bash

# Post the build notifications for a PR into a per-PR Discord forum thread.
# It runs twice per commit:
#   - NOTIFY_MODE=start  -> posted as the builds kick off ("build started at ...").
#   - NOTIFY_MODE=result -> posted once both platforms finish, listing each
#     platform's install link (the build jobs hand their install URLs here,
#     masked). This is the default.
#
# Thread lifecycle:
#   - DISCORD_THREAD_ID empty  -> create the PR's forum thread (webhook
#     thread_name; the channel MUST be a Discord Forum channel) and reply into it.
#   - DISCORD_THREAD_ID set     -> reply into that existing thread.
# The resulting thread id is written to DISCORD_THREAD_ID_OUT so the caller can
# persist it (a hidden marker on the PR status comment) and reuse it next commit.
#
# Public-repo hygiene: install URLs are registered as log masks and only ever
# sent to Discord; nothing prints the URLs, the webhook, or the internal host.
#
# Required env: DISCORD_WEBHOOK_URL, PR_NUMBER
# Optional env: NOTIFY_MODE (start|result, default result), DISCORD_THREAD_ID,
#   DISCORD_THREAD_ID_OUT, PR_TITLE, PR_URL, COMMIT_SHA, BUILD_STARTED_AT
#   (unix seconds, defaults to now), IOS_RESULT, IOS_URL, ANDROID_RESULT,
#   ANDROID_URL

set -euo pipefail
umask 077

# Guarantee no failure is ever silent. Every labeled failure below writes its own
# redacted diagnostic; this backstop catches an unexpected `set -e` death (e.g. a
# missing required var, before any labeled stage is reached) so the caller always
# gets a reason. It only ever emits an exit status — never a URL, host, or
# webhook — so it keeps the public-log hygiene the isolation test enforces.
on_notify_exit() {
  local status=$?
  [[ "$status" -eq 0 ]] && return
  if [[ -n "${NOTIFY_DIAG_FILE:-}" && ! -s "$NOTIFY_DIAG_FILE" ]]; then
    printf 'notify exited with status %s before any labeled stage (check DISCORD_WEBHOOK_URL / PR_NUMBER are set)\n' \
      "$status" >>"$NOTIFY_DIAG_FILE" 2>/dev/null || true
  fi
  echo "Discord notify script exited with status $status." >&2
}
trap on_notify_exit EXIT

: "${DISCORD_WEBHOOK_URL:?DISCORD_WEBHOOK_URL must be set}"
: "${PR_NUMBER:?PR_NUMBER must be set}"

mask() {
  [[ -n "${GITHUB_ACTIONS:-}" && -n "${1:-}" ]] && echo "::add-mask::$1" || true
}

# Mask the install URLs (and their host prefix) before anything else runs.
for url in "${IOS_URL:-}" "${ANDROID_URL:-}"; do
  [[ -z "$url" ]] && continue
  mask "$url"
  host="${url#*://}"
  host="${host%%/*}"
  mask "$host"
done

# Build one platform line: a markdown install link on success, a failure note
# otherwise.
platform_line() {
  local emoji="$1" name="$2" result="$3" url="$4"
  if [[ "$result" == "success" && -n "$url" ]]; then
    printf '%s **%s** — [install](%s)' "$emoji" "$name" "$url"
  else
    printf '%s **%s** — ❌ build failed' "$emoji" "$name"
  fi
}

short_sha="${COMMIT_SHA:0:7}"
notify_mode="${NOTIFY_MODE:-result}"

if [[ "$notify_mode" == "start" ]]; then
  # Unix seconds so Discord renders the time in each reader's own timezone.
  started_at="${BUILD_STARTED_AT:-}"
  [[ "$started_at" =~ ^[0-9]+$ ]] || started_at="$(date -u +%s)"
  reply="$(
    if [[ -n "$short_sha" ]]; then
      printf '🏗️ **Build `%s` started** at <t:%s:F> (<t:%s:R>)' "$short_sha" "$started_at" "$started_at"
    else
      printf '🏗️ **Build started** at <t:%s:F> (<t:%s:R>)' "$started_at" "$started_at"
    fi
    printf '\n🍎 **iOS** — ⏳ building\n🤖 **Android** — ⏳ building'
  )"
else
  reply="$(
    if [[ -n "$short_sha" ]]; then
      printf '**Build `%s`**\n' "$short_sha"
    else
      printf '**New build**\n'
    fi
    platform_line '🍎' 'iOS' "${IOS_RESULT:-}" "${IOS_URL:-}"
    printf '\n'
    platform_line '🤖' 'Android' "${ANDROID_RESULT:-}" "${ANDROID_URL:-}"
  )"
fi

# Append a REDACTED diagnostic (HTTP status / stage only — never a URL, host,
# webhook, or response body) for the caller to surface on failure.
diag() {
  [[ -n "${NOTIFY_DIAG_FILE:-}" ]] && printf '%s\n' "$1" >>"$NOTIFY_DIAG_FILE" || true
}

# http_post <url> : reads the JSON payload from stdin (robust across platforms,
# safe for UTF-8) and prints "<response-body>\n<http_code>". Kept quiet so
# nothing can echo a URL. The caller splits off the trailing status line — doing
# it here would be lost, since a piped function runs in a subshell.
http_post() {
  curl --silent --show-error \
    --header 'Content-Type: application/json' \
    --data-binary @- \
    --write-out $'\n%{http_code}' \
    "$1" 2>/dev/null
}

thread_id="${DISCORD_THREAD_ID:-}"

if [[ -z "$thread_id" ]]; then
  # Create the PR's forum thread. thread_name is capped at 100 chars by Discord.
  title="${PR_TITLE:-}"
  thread_name="PR #${PR_NUMBER}"
  [[ -n "$title" ]] && thread_name="PR #${PR_NUMBER}: ${title}"
  thread_name="${thread_name:0:100}"

  root="$(
    printf '🏗️ **Builds for PR #%s**' "$PR_NUMBER"
    [[ -n "${PR_URL:-}" ]] && printf '\n%s' "$PR_URL"
  )"

  create_payload="$(jq -nc --arg name "$thread_name" --arg content "$root" \
    '{thread_name: $name, content: $content}')"

  out="$(printf '%s' "$create_payload" | http_post "${DISCORD_WEBHOOK_URL}?wait=true")" || true
  code="${out##*$'\n'}"
  response="${out%$'\n'*}"
  case "$code" in
    2*) ;;
    *)
      diag "thread create failed: HTTP ${code:-000}"
      echo "Failed to create the Discord forum thread (is the channel a Forum channel?)." >&2
      exit 1
      ;;
  esac

  thread_id="$(printf '%s' "$response" | jq -r '.channel_id // empty' 2>/dev/null || true)"
  if [[ -z "$thread_id" ]]; then
    diag "thread create: no channel_id in response (HTTP $code)"
    echo "Discord did not return a thread id (is the webhook channel a Forum channel?)." >&2
    exit 1
  fi
fi

reply_payload="$(jq -nc --arg content "$reply" '{content: $content}')"
out="$(printf '%s' "$reply_payload" | http_post "${DISCORD_WEBHOOK_URL}?thread_id=${thread_id}")" || true
code="${out##*$'\n'}"
case "$code" in
  2*) ;;
  *)
    diag "thread reply failed: HTTP ${code:-000}"
    echo "Failed to post the build reply into the Discord thread." >&2
    exit 1
    ;;
esac

# Hand the thread id back for persistence (it is a channel snowflake, not a
# secret, but it is never printed to keep the logs clean).
if [[ -n "${DISCORD_THREAD_ID_OUT:-}" ]]; then
  printf '%s' "$thread_id" > "$DISCORD_THREAD_ID_OUT"
fi

echo "Posted the build notification to the PR thread."
