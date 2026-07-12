# Trail stash — implementation plan (design of record)

> **Status: IN PROGRESS.** Contract for an always-on, **ciphertext-blind,
> stateless, fully in-memory** iroh-docs replica ("stash") plus a push-to-sync
> waker, added to solve offline delivery between phones that are rarely online at
> the same time. The **pure core is implemented and unit-tested** under
> `infra/trail-stash/rust/` (config, retention, subscription registry, MLS
> delivery-service seam, waker seam, control-API validation, PSK gate, push-payload
> builders). The **live node** (`node.rs`, `live` feature) boots the in-memory iroh
> replica + HTTP control API and is **runtime-verified end-to-end**: a two-node
> integration test (`cargo test --features live`) proves import → reconcile → wake
> against real iroh nodes (2026-07-10). Fully wired: **APNs/FCM push waker**,
> **client opt-in + StashClient**, **expo-notifications push tokens + background
> sync**, a **Friends-tab toggle**, and a **Dockerfile + `INSTALL.md`** deploy
> runbook (all TS jest-tested). **Only remaining glue:** APNs-JWT/FCM-OAuth
> credential *minting* (payload construction + send path are done; the sender
> currently reads a static bearer). Keep in sync with the streetCryptid app's
> `ARCHITECTURE.md` (§5–6, §9, §10).

> **Repository note.** This is the extracted, self-contained server. The `§N`
> references throughout point at the streetCryptid **app** repo's internal
> `docs/social/ARCHITECTURE.md`, which is not shipped here — they are kept as design
> provenance. `EXPO_PUBLIC_*` variables and "repo-root `.env`" likewise refer to the
> app side of the contract. Nothing in this repo needs those files to build, test, or
> deploy; see `README.md`, `INSTALL.md`, and `charts/trail-stash/`.

## Design constraints (decided 2026-07-10)

- **Opt-in.** Nobody is replicated by default. The stash only holds a namespace
  after a device presents its read-ticket (`POST /v1/namespaces`), and the client
  only sends that grant when the user turns the feature on (persisted flag,
  default off; `LocationSharingService.setStashOptIn`). No grant → no data.
- **PSK gate.** The control API requires `Authorization: Bearer <TRAIL_STASH_PSK>`
  on `/v1/*` when set — a low-grade anti-abuse shared secret mirroring the relay
  auth token (`EXPO_PUBLIC_TRAIL_STASH_PSK` on the client). Not a real auth
  boundary; the trail data's security never rests on it (E2E encrypted regardless).
- **Stateless & fully in-memory.** No disk, no database. The docs replica
  (`Docs::memory()`), the blobs store (`MemStore`), and the `(namespace → push
  token)` subscription registry all live in RAM only. A restart clears
  everything; devices re-register opportunistically. This is the same deliberate
  tradeoff as `pairing-mailbox` (in-memory, restart-clears) and is a security
  property: nothing user-derived is ever at rest on the stash.
- **Ciphertext-blind & secure.** The stash is never a recipient, never wrapped
  for (§4), holds no keys, performs no crypto, and never logs push tokens (only a
  redacted suffix). It sees relay-grade metadata only (§10).
- **MLS seam now, MLS later.** In MLS (RFC 9420) terms the stash is an untrusted
  **Delivery Service**. We add the interface (`DeliveryService`) and a
  **passthrough stub** (`PassthroughDelivery`, admits every envelope as opaque
  bytes = today's behavior) so a future MLS-aware delivery service can drop in
  without touching the replica plumbing. See "MLS seam" below.

## Problem

Location sharing has two channels (ARCHITECTURE §5):

- **Live path** (iroh-gossip) — ephemeral, needs both phones online at once. Not
  the thing to fix; it is *designed* to drop history.
- **Durable path** (iroh-docs) — every fix is also written under `author/seq` to
  a replicated namespace, and a rejoining peer runs range reconciliation to
  backfill (`docs.rs::sync` / `sync_all`).

The durable path already *is* store-and-forward, but §1.3 assumes **some other
pool member is online** when you reconnect. In a two-person pool (A↔B) that set
is empty: only A holds A's namespace, so if A and B are never online together,
reconciliation never runs and B never receives A's trail.

**Fix: add one always-on member to every pool.** No new wire protocol — a peer
that never sleeps, plus a nudge to wake phones so they actually pull.

## What the stash is (and is not)

The stash is a **headless copy of the existing `iroh-location` Rust node**,
running server-side, that imports each user's trail-namespace **read-ticket** and
replicates the encrypted envelopes 24/7.

- **It is ciphertext-blind by construction.** Per-recipient wraps (§4) are only
  minted for *active recipients*; the stash is never a recipient, so it is never
  wrapped for. It holds pure opaque bytes forever. It sees exactly what a relay
  sees — namespace membership, timing, sizes (already threat-modeled in §10,
  "relay operator"). It performs **no crypto** and has **no keys** to user data.
- **Revocation is unchanged.** Dropping a friend = dropping their wrap. The stash
  keeps replicating ciphertext that stays useless to anyone not wrapped for. The
  stash is structurally "a peer present for replication, never present for
  content" — the same shape as a revoked recipient (§6, §10).
- **It reuses the whole durable path.** `import_ticket`, `read_ticket`,
  `sync`/`sync_all`, and the rolling-window `prune`/`keys_to_prune` already exist
  in `docs.rs`. The client change is: add the stash's `EndpointAddr` to the peer
  list passed into `sync`. That is nearly the entire client delta.

It is **not** a mailbox: a trail is a growing log, not a one-time handoff, so
burn-on-read (the `pairing-mailbox` model) is the wrong shape here. Reconciliation
gives cursors/dedup/merge for free; a dumb blob store would re-solve them on the
client.

## The other half: push-to-sync (designed in from the start)

A replica makes data *available*; a backgrounded phone still has to **wake and
pull** (ARCHITECTURE §9: force-stop blocks delivery; OS background limits delay
it). So the stash also runs a small waker:

1. The stash observes `LiveEvent::InsertRemote` for a namespace it replicates.
2. It sends a **silent push** (APNs / FCM data-only) to every device that
   subscribed to that namespace.
3. The device's headless runtime wakes → `syncTrail` → reconciles against the
   stash → backfills the missed fixes.

Waking the *author* of the new entry is a harmless no-op (it already has the
data), so the waker does not need to distinguish writer from reader.

**Metadata note:** to wake devices the stash learns `(namespace → push tokens)`.
This is identity-adjacent metadata, on par with the relay-operator exposure
already accepted in §10, and is the reason to self-host. The stash never learns
locations.

## Contract the app depends on (do not change without updating the app)

### Client-visible config (repo-root `.env`)

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_TRAIL_STASH_TICKET` | The stash node's iroh node/endpoint ticket. The app parses it to an `EndpointAddr` and adds it to the peer list for `sync`/`sync_all`. Unset → no stash; behavior falls back to today's peer-only reconciliation. |
| `EXPO_PUBLIC_TRAIL_STASH_URL` | Base URL of the stash's small HTTP control API (grant submission + push registration). |

### Grant + subscribe API (HTTP, on `EXPO_PUBLIC_TRAIL_STASH_URL`)

One call per namespace the device participates in (its own + each imported
friend). Presenting a **read-ticket** *is* the grant — a read-ticket is a
capability, no other auth needed to replicate.

- `POST /v1/namespaces` — body `{ readTicket, pushToken, platform }`.
  - Stash calls `import_ticket(readTicket)` (idempotent per namespace), begins
    replicating, and records `pushToken` as interested in that namespace.
  - The device sends this for **its own** trail (so friends can catch up while it
    is offline) and for **each friend's** trail (so it gets woken on their
    updates).
- `DELETE /v1/namespaces/{namespaceId}/subscription` — drop this device's push
  subscription for a namespace (unfriend / disable). Idempotent; does not leak
  presence.
- `GET /healthz` — liveness.

Registration is renewed opportunistically (push tokens rotate; tickets refresh
addrs). Exact renewal cadence TBD in Phase 1.

### Retention (configurable — per Phase 0 decision)

The stash runs the same rolling-window `prune` as the app, driven by a config
value rather than a hard-coded window. A phone offline longer than the window
loses the gap that was pruned — so the window is the knob that trades
data-at-rest against how long an offline phone can catch up.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRAIL_STASH_RETENTION_HOURS` | `48` | Prune entries older than this. Match the app's 24–48h view for full catch-up, or lower toward ~1h to minimize server data-at-rest. |
| `TRAIL_STASH_PRUNE_INTERVAL_MIN` | `15` | How often the prune sweep runs. |
| `PORT` | `8787` | Control-API port. |
| `APNS_*` / `FCM_*` | — | Push provider credentials (kept out of the repo, per §7). |

## MLS seam (interface + passthrough stub)

The stash matches the MLS **Delivery Service** role: an untrusted server that
stores/forwards opaque group messages between members without their secrets.
Today the durable path ships per-recipient HPKE-wrapped envelopes (§4) and the
stash replicates them blind. To keep a clean upgrade path to MLS group crypto:

```rust
// infra/trail-stash/rust/src/mls.rs
pub trait DeliveryService: Send + Sync {
    fn admit(&self, envelope: &EnvelopeRef<'_>) -> Admission;   // Accept | Reject(reason)
}
pub struct PassthroughDelivery; // admits every envelope unchanged — current behavior
```

- **Now:** `PassthroughDelivery` accepts all bytes as opaque. Ciphertext-blindness
  is preserved; the stash keeps no MLS state.
- **Later:** a real impl can become aware of MLS message *framing* (handshake vs
  application, epoch/Commit ordering, Welcome routing) — but never group secrets.
  It slots in where the replica admits a reconciled `InsertRemote`, no other
  plumbing changes.

## Crate layout

Standalone Rust crate (no workspace root); pure core builds and tests without the
iroh stack, live node is behind the `live` feature.

```
infra/trail-stash/
  PLAN.md · README.md · INSTALL.md      # design · API/security · deploy runbook
  rust/
    Dockerfile · .dockerignore          # distroless build of the live binary
    Cargo.toml            # `live` feature gates iroh/tokio/axum; default = pure core
    src/
      lib.rs              # module wiring + docs
      config.rs           # env → StashConfig (retention hours, prune interval, port); clamped
      retention.rs        # RetentionPolicy: hours → cutoff/expiry (injectable clock)  [pure]
      subscriptions.rs    # in-memory NamespaceRegistry (namespace → push subs)        [pure]
      mls.rs              # DeliveryService seam + PassthroughDelivery stub            [pure]
      waker.rs            # Waker seam + NoopWaker stub (APNs/FCM later)               [pure]
      api.rs              # control-API request types + validation                     [pure]
      node.rs             # #[cfg(feature="live")] in-memory replica + waker + prune loop
      bin/trail-stash.rs  # #[cfg(feature="live")] main
```

## Implementation phases

**Phase 0 — decisions (done):** stash node (not mailbox); retention
configurable; push-to-sync in scope from the start; opt-in; stateless in-memory;
MLS delivery-service seam stubbed.

**Phase 1 — stash node + reconciliation.**
- Standalone crate `infra/trail-stash/rust` (does **not** depend on
  `iroh-location`: the stash never decrypts, so it needs only iroh + docs + blobs
  + gossip). Boots a headless node with **in-memory** `Docs::memory()` + `MemStore`
  and relay transport; **no** GPS, **no** gossip publish.  *(pure core: DONE &
  tested; live `node.rs`: written, unverified pending iroh build.)*
- Control API (`POST /v1/namespaces`, `DELETE …/subscription`, `/healthz`) →
  `docs.import(ticket)` + in-memory subscription registry.
- Prune loop on `TRAIL_STASH_RETENTION_HOURS` / `TRAIL_STASH_PRUNE_INTERVAL_MIN`.
  Note: because entries are authored by the phones, cross-author eviction from an
  in-memory replica is best-effort; the hard memory bound is the retention window
  × fix rate × granted namespaces, plus the fact that a restart clears everything.
- Client (later this phase): a user **opt-in** toggle; when on, `POST
  /v1/namespaces` for its own + each friend's namespace; add
  `EXPO_PUBLIC_TRAIL_STASH_TICKET` to the `sync`/`sync_all` peer list. Verify B
  backfills A's trail with **A offline** and only the stash up.

**Phase 2 — push-to-sync waker. (DONE, minus credential minting.)**
- Stash watches `LiveEvent::InsertRemote` per namespace → silent push to that
  namespace's subscribed tokens (`node.rs` → `waker.rs` `HttpPushWaker`).
- Payloads (`push.rs`) are silent/background/data-only and tested.
- Client: `push-token-provider.ts` acquires the native APNs/FCM token via
  expo-notifications and registers a `trail-sync` receive handler → `syncTrail`;
  the token is sent on friend `POST /v1/namespaces`. iOS `remote-notification`
  background mode + `expo-notifications` plugin added to `app.json`.
- **Remaining:** mint short-lived APNs ES256 JWT / FCM OAuth2 tokens (replace the
  static-bearer `EnvCredentials`); optionally a TaskManager background task for
  fully-suspended wake (the receive listener covers the common case).

**Phase 3 — harden + operate.**
- Subscription auth/renewal, token rotation, rate limiting (mirror
  `pairing-mailbox` hardening), per-namespace replication caps.
- Self-host deployment (Docker), retention/GC ops, metrics. Deployment creds stay
  out of the repo (§7).

## Threat-model additions (fold into ARCHITECTURE §10 when built)

- **Stash operator:** holds ciphertext + strictly more metadata than a bare relay
  — namely `(namespace → push token)` subscription maps and replication timing.
  Cannot read locations (never wrapped for; §4). Self-hosting is the mitigation.
- **Availability:** the stash is a convenience replica, not a source of truth.
  Losing it degrades to today's peer-only reconciliation; it cannot forge or
  alter fixes (envelopes are ed25519-signed, §4/§7).
- **Push metadata:** silent pushes reveal "namespace X changed" timing to the OS
  push provider (Apple/Google), independent of the stash operator.

## Open questions to settle in Phase 1

- **Grant UX:** automatic at pairing, or an explicit "cloud backup" toggle per
  friendship? (Affects §9a reciprocal-grant flow.)
- **Subscription renewal cadence** and push-token rotation handling.
- **Reachability:** confirm the stash's `EndpointAddr` in the client peer list
  actually reconciles over relay when both direct-IP paths are dropped (the same
  relay-only caveat `docs.rs::sync` already guards with `SYNC_IDLE_TIMEOUT_SECS`).
