# trail-stash

An always-on, **ciphertext-blind**, **stateless**, **fully in-memory** iroh-docs
replica. It exists so two phones that are rarely online at the same time can still
exchange their encrypted location trails: the stash is a headless member of every
**opted-in** sharing pool, replicates the encrypted trail 24/7, and nudges
backgrounded phones to sync via a silent push.

See `PLAN.md` for the full design of record. (`PLAN.md`'s `§N` references point at
the streetCryptid **app** repo's internal `docs/social/ARCHITECTURE.md`, which is not
shipped in this standalone repo.)

## Threat model: this service is blind

- The stash is **never a recipient**, so it is **never wrapped for** (ARCHITECTURE
  §4). It holds only opaque, sealed envelope bytes, has **no keys**, and performs
  **no crypto**. Revocation carries over unchanged: a dropped friend keeps
  replicating ciphertext it can no longer decrypt.
- It sees only relay-grade **metadata**: which namespaces it replicates, entry
  timing/sizes, and — to send wake-ups — a `(namespace → push token)` map. It
  never sees a location. Self-hosting is the mitigation for the metadata.
- **Stateless & fully in-memory.** No disk, no database. The docs replica
  (`Docs::memory()`), the blobs store (`MemStore`), and the subscription registry
  live in RAM only. A restart clears everything; devices re-register on their next
  opted-in sync. Nothing user-derived is ever at rest here.
- **Opt-in.** Nothing is replicated until a device presents a read-ticket. No
  grant → no data.
- All tracing output centrally redacts IP addresses and identity-like values. Push
  tokens are logged only as their platform plus `[REDACTED]`, with no correlatable suffix.

The stash provides no confidentiality on its own; envelopes are already E2E
encrypted per-recipient on-device before they ever reach it.

## MLS

In MLS (RFC 9420) terms the stash is an untrusted **Delivery Service**. The
`DeliveryService` trait (`src/mls.rs`) is the seam; the shipped `PassthroughDelivery`
admits every envelope as opaque bytes (today's behavior). A future MLS-aware
delivery service drops in there without touching the replica plumbing. See
`PLAN.md` → "MLS seam".

## Control API

Opt-in and wake registration. Presenting a read-ticket **is** the grant. When
`TRAIL_STASH_PSK` is set, `/v1/*` requires `Authorization: Bearer <psk>`
(anti-abuse gate, mirrors the relay token; `/healthz` is always open).

### `POST /v1/namespaces` — grant + (optionally) subscribe

- Body: `{ "read_ticket": "<iroh-docs read ticket>", "push_token"?: "<token>", "platform"?: "apns"|"fcm" }`
  - `push_token` and `platform` must be supplied together, or both omitted.
  - Unknown JSON fields are rejected.
- **201 Created** on success (imports the namespace, records the opt-in + optional
  wake subscription; idempotent per namespace).
- **400 Bad Request** for a malformed ticket, partial push fields, bad platform,
  or an over-long/empty token.
- **502 Bad Gateway** if importing the ticket fails transiently.

### `DELETE /v1/namespaces/{namespaceId}/subscription` — stop being woken

- `{namespaceId}` is 64 lowercase hex chars.
- Body: `{ "push_token": "<token>", "platform": "apns"|"fcm" }`.
- **204 No Content** whether or not the subscription existed (idempotent, does not
  leak presence). The namespace stays replicated.

### `GET /healthz`

- **200 OK**, for liveness/readiness checks.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TRAIL_STASH_SECRET_KEY` | — | **Required.** 64 hex chars (32-byte ed25519 seed) giving the stash a stable dialable identity so its ticket survives restarts. A key, not user data — inject from a secret manager. Generate: `openssl rand -hex 32`. |
| `PORT` | `8787` | Control-API port. |
| `TRAIL_STASH_RETENTION_HOURS` | `48` | Prune entries older than this (clamped 1–336). Lower toward ~1h to minimize data-at-rest; match the app's 24–48h window for full catch-up. |
| `TRAIL_STASH_PRUNE_INTERVAL_MIN` | `15` | How often the prune sweep runs (clamped 1–1440). |
| `TRAIL_STASH_RELAY_URLS` | — | Comma-separated custom iroh relay URLs. Unset uses the built-in n0 relay map. Use the same URLs as the app's `EXPO_PUBLIC_IROH_RELAY_URLS`. |
| `TRAIL_STASH_RELAY_TOKEN` | — | Optional bearer token sent to every configured custom relay. |
| `TRAIL_STASH_PSK` | — | Control-API pre-shared key. When set, `/v1/*` requires `Authorization: Bearer <psk>`. Must match the app's `EXPO_PUBLIC_TRAIL_STASH_PSK`. Unset ⇒ gate disabled (warned at startup). |
| `APNS_BUNDLE_ID` / `APNS_HOST` | — / `api.push.apple.com` | Enables the APNs push route. |
| `FCM_PROJECT_ID` | — | Enables the FCM push route. |
| `APNS_BEARER` / `FCM_BEARER` | — | **Placeholder** static push credentials (`EnvCredentials`) until real APNs-JWT / FCM-OAuth minting lands. |

The waker builds correct silent-push payloads (tested) and sends them when a push
route is configured; the credential-minting is the remaining piece. With no push
env set, the waker is a no-op and offline catch-up still works via reconciliation.

## Build & run — from source

The default build is the **pure core** (config, retention, subscription registry,
MLS seam, waker seam, control-API validation) with no iroh deps — fast, host-portable,
and fully unit-tested:

```powershell
cd infra\trail-stash\rust
cargo test
```

The live node + HTTP server is behind the `live` feature (pulls in iroh + tokio +
axum). It targets iroh-docs `0.101` / iroh-blobs `0.103` and **compiles cleanly**
against them (`cargo check --features live`); it is not yet runtime-tested
end-to-end (no two-node integration test of import → reconcile → wake):

```powershell
cd infra\trail-stash\rust
$env:TRAIL_STASH_SECRET_KEY = (openssl rand -hex 32)
cargo run --features live
```

## Deploy

### Container image

Published to GHCR by CI (see `.github/workflows/publish.yml`):

```bash
docker pull ghcr.io/<owner>/trail-stash:latest        # or a :sha-xxxx / :X.Y.Z tag
docker run -d --name trail-stash -p 8787:8787 \
  -e TRAIL_STASH_SECRET_KEY="$(openssl rand -hex 32)" \
  -e TRAIL_STASH_PSK="$(openssl rand -hex 32)" \
  -e TRAIL_STASH_RELAY_URLS="https://relay.example.com" \
  ghcr.io/<owner>/trail-stash:latest
```

### Kubernetes (Helm)

The chart is published to GHCR as an OCI artifact. Create the identity/PSK secret once
(keep it out of Helm history), then install:

```bash
kubectl create namespace trail-stash
kubectl -n trail-stash create secret generic trail-stash \
  --from-literal=TRAIL_STASH_SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=TRAIL_STASH_PSK="$(openssl rand -hex 32)"

helm install trail-stash oci://ghcr.io/<owner>/charts/trail-stash \
  --namespace trail-stash \
  --set secret.existingSecret=trail-stash \
  --set image.tag=<sha-or-semver>

```

It runs as a single, stateless, in-memory pod (identity is pinned by the secret, so
`replicas` stays 1). Front the control API with your own TLS proxy — see `INSTALL.md`
for the full runbook and `charts/trail-stash/README.md` for every value.

The service does not emit or persist its dial ticket. Provision
`EXPO_PUBLIC_TRAIL_STASH_TICKET` to clients out of band.

## Crate layout

```
src/
  lib.rs           module wiring + security posture
  config.rs        env → StashConfig (clamped)                [pure, tested]
  retention.rs     RetentionPolicy (hours → cutoff/expiry)    [pure, tested]
  subscriptions.rs in-memory NamespaceRegistry                [pure, tested]
  mls.rs           DeliveryService seam + PassthroughDelivery [pure, tested]
  waker.rs         Waker seam + NoopWaker                     [pure, tested]
  api.rs           control-API request types + validation     [pure, tested]
  node.rs          in-memory replica + HTTP API               [live feature]
  bin/trail-stash.rs  main                                     [live feature]
```
