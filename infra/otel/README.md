# Developer observability (OTEL) — "who dropped my ping?"

A self-hosted OpenTelemetry stack that receives **traces, logs and span-derived metrics from every
component of streetCryptid**: the app's JS layer, the native Rust core (`iroh-location`, including
iroh's own relay/`net_report`/magicsock diagnostics), and the
[trail-stash](https://github.com/unrealJune/trail-stash) server.

It answers two different questions, and it is worth knowing which one you have:

1. **"Where did this ping die?"** — follow one envelope across device A → stash → devices B/C/D.
   That is the correlation model and the cookbook below, and the `ping flow` dashboard.
2. **"Why is this phone doing nothing at all?"** — the harder one, because a phone that has stopped
   being woken emits no spans, no logs and no errors. It looks exactly like a phone whose owner is
   sitting still. That is what `device.health`, the metrics pipeline and the
   `device health` dashboard are for; see [Reading silence](#reading-silence).

**Strippable, and provably so.** `EXPO_PUBLIC_DEV_TELEMETRY=1` is what compiles telemetry into the
app at all: without it `metro.config.js` resolves `@/features/dev/telemetry` to `index.noop.ts` and
the encoder, shipper, journal and console bridge are **not in the bundle**. The mobile Rust core has
the same property via `--no-default-features`.

**But it is currently ON for every profile, `production` included** — deliberately and temporarily,
because production _is_ TestFlight for us right now and the phones we debug are the ones we install
the store build on. `scripts/check-release-telemetry.mjs` fails CI if a store-bound profile enables
telemetry _without_ a matching entry in its `ACKNOWLEDGED` map; the entry there records why and what
ends it. Deleting that entry is how the exception gets revoked — the check re-arms immediately.
Before the app reaches anyone outside our own TestFlight group this has to be settled one way or the
other: strip it, or declare the collection in App Store Connect and the privacy policy.

## Quick start

```sh
cd infra/otel
docker compose up -d
```

- Grafana: <http://localhost:3000> (anonymous admin — LAN-only dev tool). Both dashboards are
  provisioned from `grafana/`, so a fresh stack comes up with them already loaded — edits made in
  the UI are overwritten on restart, so commit them to `grafana/dashboards/`.
- Collector OTLP intake: `http://<lan-ip>:4318` (HTTP) / `:4317` (gRPC)

Retention: traces 7 days (Tempo), logs 30 days (Loki), span-derived metrics 90 days (Prometheus).
The split is deliberate — traces are big and are only ever read while investigating something
recent; the metrics are what answer "when did this last work?", which is usually asked days later.

Point the components at it (use the machine's **LAN IP**, not `localhost` — phones must reach it):

| Component              | How                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App (JS + native core) | `.env.local`: `EXPO_PUBLIC_DEV_TELEMETRY=1` **and** `EXPO_PUBLIC_OTEL_ENDPOINT=http://192.168.1.10:4318` — restart Metro (both are inlined at bundle time). every profile in `eas.json` currently sets them, `production` included — see **Developer-only** above. |
| trail-stash            | env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318` (Helm: `config.otel.endpoint`). Dormant when unset.                                                                                                                                                           |

## The correlation model

Location payloads are E2E-encrypted and the stash is ciphertext-blind, so **no single W3C trace
context can ride a ping end-to-end** — the pipe itself (gossip broadcast + iroh-docs set
reconciliation) carries no headers, and the stash couldn't read one anyway.

Instead, every party stamps its spans with **join attributes** it can legitimately observe:

| Attribute        | What it is                                                                                                                                              | Who sees it                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `sc.entry_hash`  | First 10 hex chars of the blake3 of the _sealed envelope_ — identical to the iroh-blobs content hash of the docs entry                                  | sender, stash, receivers                           |
| `sc.author`      | Short endpoint id of the sender                                                                                                                         | everyone in the pool (+ stash, from the entry key) |
| `sc.seq`         | The fix's monotonic sequence number                                                                                                                     | sender, stash (entry key), receivers               |
| `sc.namespace`   | Short trail namespace id                                                                                                                                | stash, namespace members                           |
| `sc.drop_reason` | Why a fix will never reach the wire / the UI (`sampling-suspended`, `outbox-overflow`, `coalesced`, `engine-not-running`, `unknown-or-removing-author`) | the device that dropped it                         |

Real parent/child trace context flows only where a real channel exists:

- **within one app operation**: explicit context propagation groups a background location wake or
  backfill under one root span (Hermes has no reliable `AsyncLocalStorage`, so this is deliberately
  passed through each async boundary).
- **app → native core**: Android and iOS pass `traceparent` over the Expo/UniFFI bridge, so
  `gossip.publish`, `docs.write`, and `trail.sync` remain in the app operation's trace while retaining
  their own `streetcryptid-core` service identity.
- **app → stash control API**: the app sends `traceparent`; the stash's `http.request` span
  parents on it (one trace covers register/unsubscribe round-trips).
- **stash → woken phone**: the silent push payload carries the `stash.wake.push` span's
  `traceparent`; the phone's `push.wake` span **links** to it.

Every span also carries `service.name` (`streetcryptid-app`, `streetcryptid-core`, `trail-stash`)
and `service.instance.id` (short endpoint id) — so "device A" vs "device B" is always one filter.

## The story of one ping (span map)

```
device A                                stash                       device B
────────                                ─────                       ────────
bg.wake            (fixes, net/battery/app state; ALSO emitted with fixes=0 for an
│                    empty or errored delivery — a wake is a wake)
└ bg.dispatch      (branch: mounted | headless)
  └ engine.ingest  (motion, decision, sc.drop_reason?)
    └ outbox.enqueue (coalesced / overflow?)
    └ outbox.drain   (published/retained, publish.failed reason)
      └ publish.fix        (sc.seq)
        ├ gossip.publish*  (sc.entry_hash)  ─ live path ───────►  gossip.receive (sc.entry_hash, outcome)
        └ docs.write*      (sc.entry_hash)  ─ LOCAL replica only
    └ trail.push.app                        ─ durable path ─►  stash.entry.received (sc.entry_hash)
      └ trail.push*        (entries_sent, finished)
                                                                  └ trail.sync.app (recovered)
                                                                    └ fix.received.app (sc.seq, drop?)
```

`docs.write` does **not** reach the stash on its own — it writes the local replica, and iroh-docs
broadcasts a local insert only for namespaces `start_sync` has marked as syncing. `trail.push`
(after a drain) or `trail.sync` is what actually moves the envelope. A `publish.fix` with no
`trail.push.app` after it in the same wake is a fix that never left the phone.

`*` Native spans are direct children of `publish.fix` on Android and iOS.

Device B is no longer woken by the stash: push-token upload was removed (ARCHITECTURE §10), so
there is no `stash.wake.push` → `push.wake` hop any more. B pulls on its own schedule — the
periodic refresh or the live-request poll — which is why a gap of up to one refresh interval
between a push and the friend seeing it is normal rather than a fault.

### Spans that fire when the pipeline does NOT run

These exist because their absence was indistinguishable from a phone that was never woken. None of
them describe a ping; all of them describe why there wasn't one.

| Span                                                   | Says                                                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.health`                                        | the periodic liveness record — OS permissions, task registration, `last_*_age_ms`                                                                     |
| `storage.degraded`                                     | persistence fell back to memory; nothing this device saves survives a restart                                                                         |
| `outbox.load` (`sc.drop_reason=outbox-*`)              | the durable queue was unreadable, so every fix waiting in it is gone                                                                                  |
| `cadence.rearm`                                        | the OS refused a cadence change, so sampling is pinned at an interval nobody chose                                                                    |
| `engine.failed`                                        | `doFlush` / `heartbeat` threw; the engine is in `error` and only the UI knew                                                                          |
| `bg.selfheal` (`sharing-disabled` / `already-running`) | the self-heal ran and had nothing to do — distinct from never running                                                                                 |
| `bg.session` (`precheck-empty`)                        | a headless wake found an empty outbox — distinct from no wake at all                                                                                  |
| `revive.arm` (`outcome`)                               | whether the iOS tripwire is actually armed, rather than only believed to be — `armed` \| `throttled` \| `task-undefined` \| `unavailable` \| `failed` |

## Follow-one-ping cookbook (TraceQL, in Grafana → Explore → Tempo)

Every hop of one envelope, on any device or the stash:

```traceql
{ span.sc.entry_hash = "ab12cd34ef" }
```

Everything device A published in a window (get the author id from any of its spans):

```traceql
{ span.sc.author = "ab12cd34ef" }
```

All drops, anywhere, with reasons:

```traceql
{ span.sc.drop_reason != "" }
```

Wakes that published nothing (the classic "phone woke but the ping never left"):

```traceql
{ name = "outbox.drain" && span.published = 0 }
```

Phones the OS has stopped running the periodic refresh on. `bg.refresh` counts the runs we heard
about; `last_refresh_age_ms` is the durable stamp the phone carries locally, so it survives the
window where the refresh has stopped AND the phone cannot reach the collector — which is the same
window, more often than not. Six hours is ~24 missed runs at the requested 15-minute cadence:

```traceql
{ name = "bg.refresh" }
{ name = "device.health" && span.last_refresh_age_ms > 21600000 }
```

Both platforms throttle this task to nothing without ever reporting it as unavailable. On
2026-08-29 an iPhone read `refresh_registered: true` + `refresh_status: available` for thirty hours
with zero `bg.refresh` spans, while a Pixel's interval decayed 15 → 24 → 214 → 687 minutes as App
Standby demoted the WorkManager job. Neither is distinguishable from a healthy phone by any other
attribute the record carries.

Pushes that never completed a reconciliation with the stash — the fixes are written locally but
stranded (`finished=false` means no `SyncFinished` before the deadline: unreachable stash, no
network, or the wake ended too early):

```traceql
{ name = "trail.push" && span.finished = false }
{ name = "trail.push" && span.entries_sent > 0 }
```

Stash-side activity for one namespace (arrivals and the pushes they triggered):

```traceql
{ name = "stash.entry.received" && span.sc.namespace = "0f1e2d3c4b" }
{ name = "stash.wake.push" && span.sc.namespace = "0f1e2d3c4b" }
```

Receives that arrived but could not be decrypted / were gated by the app:

```traceql
{ name = "gossip.receive" && span.outcome != "delivered" }
{ name = "fix.received.app" && span.sc.drop_reason != "" }
```

Arms that left no tripwire. On iOS the fence is the only mechanism that can bring a _terminated_
app back, so an arm that quietly did not happen is indistinguishable — from every other signal the
device emits — from a phone whose owner has not moved. `task-undefined` is the one to watch: the
geofence registers, the OS has no handler to deliver to, and the call site cannot tell:

```traceql
{ name = "revive.arm" && span.armed = false }
{ name = "revive.arm" && span.outcome = "task-undefined" }
```

Live mode (ARCHITECTURE §9c) — a request's whole journey, and why one was refused:

```traceql
{ name = "live.request.sent" }
{ name = "live.armed" }
{ name = "live.cancelled" }
{ name = "live.request.ignored" && span.sc.drop_reason != "" }
```

**Does gossip actually deliver phone-to-phone?** Live mode is only worth anything if a ~4s fix
reaches the watcher over gossip rather than waiting for a stash reconciliation. Put two devices in
the foreground, both sharing, and compare the counts — plus `gossip neighbor up` in Loki for how
long after bind a neighbour appears:

```traceql
{ name = "gossip.publish" }
{ name = "gossip.receive" }
```

If receives badly trail publishes, live fixes are arriving at stash-sync granularity and "live" is
not live. Worth checking before building anything further on top of it.

Logs (Grafana → Explore → Loki). iroh's relay / net_report / magicsock diagnostics from the
phones land here — this is the network-state view when sync dies after a wifi↔cellular roam:

```logql
{service_name="streetcryptid-core"} |= "net_report"
{service_name="streetcryptid-core"} |= "network_change"
{service_name="trail-stash"}
{service_name="streetcryptid-app"} |= "outbox"
{service_name=~"streetcryptid-(app|core)"} |= "ratchet response received"
{service_name="streetcryptid-core"} |= "ratchet send position persisted"
{service_name="streetcryptid-core"} |= "ratchet receive position persisted"
```

From any span, "Logs for this span" (trace→logs) jumps to that instance's logs around the span.

## Reading a dropped ping, end to end

1. **Did the phone even wake?** Filter `{ name = "bg.wake" }` for device A's
   `service.instance.id` around the gap. No span → the OS never delivered fixes (check battery
   saver / permission attributes on the last wake it _did_ get).
2. **Did the policy gate it?** The wake's `engine.ingest` child says `decision.active=false` +
   `sc.drop_reason=sampling-suspended` when battery/motion suppressed publishing.
3. **Did it die in the outbox?** `outbox.enqueue` shows `coalesced` / `outbox-overflow`;
   `outbox.drain` shows `publish.failed` with the thrown reason (`node not ready`, …) and
   `retained > 0`.
4. **Did it reach the wire?** `publish.fix` → `gossip.publish` + `docs.write` give you the
   `sc.entry_hash`. From here, one `{ span.sc.entry_hash = … }` query shows every other party
   that ever saw the envelope.
   4b. **Did it get OFF the phone?** `docs.write` is local-only. Look for `trail.push.app` /
   `trail.push` in the same wake: absent means nothing pushed it, `finished=false` means the
   stash was unreachable. Hour-long gaps in a friend's trail with healthy `publish.fix` spans
   are the signature of a publish path that never pushes.
5. **Did the stash see it?** `stash.entry.received` with the same hash. Note `wake_targets` will be
   **0** and there will be no child `stash.wake.push`: the app no longer uploads a device push
   token, so nothing is ever nudged (ARCHITECTURE §10). That is expected, not a fault.
6. **Did device B recover it?** B pulls on its own schedule now — the periodic `bg.backfill`
   (~15 min) or the 5-min live-request poll — rather than being woken. Follow
   `trail.sync.app` (`recovered` count) → `trail.backfill` log with the hash → `fix.received.app`,
   where `sc.drop_reason=unknown-or-removing-author` is the last gate that can silently eat a fix.
   A gap of up to a backfill interval between steps 5 and 6 is now normal.

## Which build is this phone running?

Ask this **first**, every time. It has been the answer more often than any other single question,
and `service.version` cannot answer it: a test branch carries whatever version `package.json` last
released, so a branch build and the release it replaced report the same string. On 2026-08-30 two
iPhones both said `1.6.1` and were running entirely different code.

`app.commit` is the answer, and it is on every span and every log line already — `app.config.ts`
computes `extra.buildProvenance` (`EAS_BUILD_GIT_COMMIT_HASH`, falling back to `git rev-parse HEAD`)
and `identity.ts`'s `getBuildResource()` puts it on the OTLP resource. Alongside it:
`app.build_profile`, `app.build_id`, `app.native_version`, `app.native_build`.

Traces — it must be `select`ed, or it will not appear in the search response:

```traceql
{resource.service.name="streetcryptid-app"}
  | select(resource.service.instance.id, resource.app.commit, resource.app.build_profile)
```

Logs — `app_commit` is **structured metadata**, not an index label, so it filters with `|` and does
NOT show up in Loki's `/labels` listing (only `service_name` and `service_instance_id` do). That
absence is why it is easy to conclude it was never plumbed:

```logql
{service_instance_id="84f86b144a"} | app_commit="b3a0b0bccb45"
```

The same stream carries `device_model`, `device_id`, `os_version`, `app_build_profile` and
`app_native_build`, all as structured metadata.

## Reading silence

A phone that has stopped working produces _less_ signal, not more, so the usual "search for the
error" reflex finds nothing and reads as "everything is fine". Two mechanisms make that legible,
and it is worth knowing what each rules out.

**1. Late data still arrives.** The app ships telemetry from its durable SQLite journal
(`shipper.ts`), not from an in-memory queue, and marks a row sent only once the collector has
accepted it. A background wake with no network keeps its telemetry and delivers it hours later
**with the original timestamps** — so a gap that later fills in retrospectively was a connectivity
problem, and a gap that stays empty is a phone that genuinely did nothing. Before this, both cases
produced the same permanent hole, because the old exporter discarded any batch it could not POST.

**2. Liveness is asserted, not inferred.** `device.health` is emitted every periodic refresh and on
foreground resume. Its value is in the _mismatches_:

| Read                                                                 | Means                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `sharing.enabled=true` + `task.location_running=false`               | the OS is not delivering location — the core background failure              |
| `perm.background` not `granted`                                      | "Always" was refused or revoked; iOS can downgrade it silently               |
| `perm.accuracy=reduced`                                              | precise location off; every fix will fail the quality gate                   |
| `task.refresh_status=restricted`                                     | Background App Refresh is off — the periodic task will never run             |
| `task.refresh_registered=true`, `last_refresh_age_ms` huge or absent | the task is registered AND permitted, and the OS is simply not running it    |
| `storage.backend=memory`                                             | outbox, friend pool and sharing intent are lost on every restart             |
| `telemetry.queued` large and growing                                 | the device is fine; it cannot reach **us**                                   |
| `last_wake_age_ms` much larger than the publish age                  | it is being woken and choosing not to publish — read the drop spans          |
| `location.state=stopped` + `location.fence_registered=false`         | parked with no way out — it will not wake until something else relaunches it |
| `location.state=moving` + a large `last_publish_age_ms`              | Core Location is delivering and nothing is anchoring — check the gate        |
| `location.wake_reason=periodic` and never anything else              | iOS: parked, ticking on the coarse stream. Publishing, and healthy           |
| `location.auth_status` not `always` while `perm.background=granted`  | the two disagree; Core Location's own read is the one that governs           |

`location.*` comes from the native runtime's `nativeBackgroundState()` (`BackgroundLocationRuntime`
on iOS). It exists because `task.location_running=true` is true of a parked phone and of a broken
one alike — on 2026-08-30 an iPhone reported exactly that while 88 minutes past its last publish,
and no other span could separate the two. Note `auth_status`, not `authorization`: the event log
redacts any key matching `/authorization|password|psk|secret|ticket|token/i`.

The top row of the device-health dashboard carries those checks as counts — devices with no
`bg.wake` in 6h, no `device.health` in 2h, any terminal native-runtime state, and publishes with no
pushes. They are **deliberately not alerts**: nothing routes to Alertmanager or Discord. The
conditions are worth seeing when you open the page, not worth waking someone for, and a rule that
pages at 3am for a phone in a pocket would be turned off within a week anyway.

Each tile ends in `or vector(0)`, which matters more than it looks: an empty PromQL result renders
as "No data", which is indistinguishable from a broken query — precisely the ambiguity this
dashboard exists to remove. A hard `0` says the check ran and found nothing.

## Privacy posture

- Join keys are 10-hex-char truncations — enough to correlate a dev session, not full identities.
- The stash redacts exported **log bodies** with the same `redact_log_line` as its console output.
  Span/log _attributes_ from dependencies (e.g. iroh's socket addresses on the phones' logs) are
  NOT redacted — which is exactly why this endpoint must always be a developer-controlled
  collector, never a hosted log service, and why production builds never configure one.
- Location coordinates are never put on spans by our instrumentation. Since the shipper drains the
  journal rather than exporting directly, everything sent is additionally run through the journal's
  redaction (`sanitize` in `event-log.ts`) on the way in — a strict improvement over the old path,
  which shipped raw attributes.
- **An OTLP collector accepts whatever is POSTed to it unless you put auth in front.** Fine for a
  LAN stack that only exists while you are looking at it. Any collector reachable from the public
  internet wants a bearer token or mTLS in front of it before phones are pointed at it, or it will
  eventually be found and written to.
  Note that the endpoint cannot be kept secret by hiding it: `EXPO_PUBLIC_*` values are inlined
  into the app bundle, so anyone with the binary can read it out. Not publishing it narrows
  drive-by discovery; only auth on the collector actually closes it.
