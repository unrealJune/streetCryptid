# Developer observability (OTEL) — "who dropped my ping?"

A self-hosted OpenTelemetry stack that receives **traces + logs from every component of
streetCryptid**: the app's JS layer, the native Rust core (`iroh-location`, including iroh's own
relay/`net_report`/magicsock diagnostics), and the [trail-stash](https://github.com/unrealJune/trail-stash)
server. Its whole purpose is to reconstruct the life of a single location ping across
device A → stash → devices B/C/D, and to show exactly where and why one died.

**Developer-only.** Telemetry code is inert unless an endpoint is configured, production builds
never configure one, and the mobile Rust cores can compile it out entirely
(`--no-default-features`). Nothing here runs in production.

## Quick start

```sh
cd infra/otel
docker compose up -d
```

- Grafana: <http://localhost:3000> (anonymous admin — LAN-only dev tool)
- Collector OTLP intake: `http://<lan-ip>:4318` (HTTP) / `:4317` (gRPC)

Point the components at it (use the machine's **LAN IP**, not `localhost` — phones must reach it):

| Component              | How                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App (JS + native core) | `.env.local`: `EXPO_PUBLIC_OTEL_ENDPOINT=http://192.168.1.10:4318` — restart Metro. For internal/TestFlight builds set the same key in the `development`/`preview` profile `env` in `eas.json` (a publicly reachable collector URL). Production leaves it unset. |
| trail-stash            | env `OTEL_EXPORTER_OTLP_ENDPOINT=http://<host>:4318` (Helm: `config.otel.endpoint`). Dormant when unset.                                                                                                                                                         |

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
bg.wake            (fixes, net/battery/app state)
└ engine.ingest    (motion, decision, sc.drop_reason?)
  └ outbox.enqueue (coalesced / overflow?)
  └ outbox.drain   (published/retained, publish.failed reason)
    └ publish.fix        (sc.seq)
      ├ gossip.publish*  (sc.entry_hash)   ─ live path ─────────►  gossip.receive (sc.entry_hash, outcome)
      └ docs.write*      (sc.entry_hash)   ─ LOCAL replica only
  └ trail.push.app                         ─ durable path ─►  stash.entry.received (sc.entry_hash)
    └ trail.push*        (entries_sent, finished)
                                            └ stash.wake.push ──►  push.wake (LINK to stash trace)
                                                                   └ trail.sync.app (recovered)
                                                                     └ trail.backfill logs (sc.entry_hash)
                                                                     └ fix.received.app (sc.seq, sc.drop_reason?)
```

`docs.write` does **not** reach the stash on its own — it writes the local replica, and iroh-docs
broadcasts a local insert only for namespaces `start_sync` has marked as syncing. `trail.push`
(after a drain) or `trail.sync` is what actually moves the envelope. A `publish.fix` with no
`trail.push.app` after it in the same wake is a fix that never left the phone.

`*` Native spans are direct children of `publish.fix` on Android and iOS.

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

## Privacy posture

- Join keys are 10-hex-char truncations — enough to correlate a dev session, not full identities.
- The stash redacts exported **log bodies** with the same `redact_log_line` as its console output.
  Span/log _attributes_ from dependencies (e.g. iroh's socket addresses on the phones' logs) are
  NOT redacted — which is exactly why this endpoint must always be a developer-controlled
  collector, never a hosted log service, and why production builds never configure one.
- Location coordinates are never put on spans by our instrumentation.
