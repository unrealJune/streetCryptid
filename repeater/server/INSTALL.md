# Trail stash — install & deploy runbook

> **Audience:** an operator deploying the trail stash and wiring the streetCryptid app to it. Read
> `PLAN.md` (design of record) and `README.md` (API + security) first if you want the "why"; this
> file is the "how", step by step. It follows the same self-host pattern as the app's other
> optional infra services.
>
> Two deploy paths are documented: **plain Docker** (Steps 2–5) and **Kubernetes via Helm**
> (Step 3-K). Pick one, then do the app-side wiring (Step 6) either way.

## What you're deploying

A single, stateless, in-memory container: a headless iroh node that replicates friends' **encrypted**
trails so two phones that are rarely online together can still exchange location history, plus a
small HTTP control API and a silent-push waker. It runs **alongside** your relay / pairing-mailbox /
tiles — it is a peer, not the relay. It holds only ciphertext (never any keys), and a restart wipes
everything.

## Prerequisites

- Docker with BuildKit (for the cache-mounted Rust build).
- A reachable iroh relay — the same one the app uses (`EXPO_PUBLIC_IROH_RELAY_URLS`). The stash uses
  the built-in n0 relays by default; pin your own for production (see "Networking").
- A way to expose the control API over TLS (a reverse proxy such as Caddy, as the tile stack uses).
- To edit the app's `.env` and rebuild the custom dev client (adds `expo-notifications` native code).
- (Optional, for push wake) Apple APNs and/or Firebase FCM credentials.

## Step 1 — generate the two secrets

```bash
openssl rand -hex 32   # → TRAIL_STASH_SECRET_KEY  (stable node identity; keep private)
openssl rand -hex 32   # → TRAIL_STASH_PSK         (control-API pre-shared key)
```

- `TRAIL_STASH_SECRET_KEY` gives the stash a **stable dial ticket across restarts**. It is a key,
  not user data — store it in your secret manager, never commit it. Losing it just rotates the
  ticket (you'd re-distribute `EXPO_PUBLIC_TRAIL_STASH_TICKET`).
- `TRAIL_STASH_PSK` is the anti-abuse gate for the control API, mirroring the relay auth token. The
  same value goes in the app as `EXPO_PUBLIC_TRAIL_STASH_PSK`.

## Step 2 — build the image

```bash
cd infra/trail-stash/rust
DOCKER_BUILDKIT=1 docker build -t trail-stash .
```

The first build compiles the full iroh stack and is slow (several minutes); re-builds are fast via
the cache mounts. If it fails on a missing native tool, the builder installs
`build-essential cmake perl pkg-config protobuf-compiler` — add whatever else your platform needs
there.

## Step 3 — run it

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `TRAIL_STASH_SECRET_KEY` | **yes** | — | 64-hex node identity seed (Step 1). |
| `TRAIL_STASH_PSK` | recommended | — | Control-API bearer; unset ⇒ open API (warned at startup). |
| `PORT` | no | `8787` | Control-API port. |
| `TRAIL_STASH_RETENTION_HOURS` | no | `48` | Prune window (clamped 1–336). Lower ⇒ less data at rest. |
| `TRAIL_STASH_PRUNE_INTERVAL_MIN` | no | `15` | Prune sweep cadence. |
| `APNS_BUNDLE_ID` / `APNS_HOST` | for iOS push | — / `api.push.apple.com` | Enables the APNs route. |
| `FCM_PROJECT_ID` | for Android push | — | Enables the FCM route. |
| `APNS_BEARER` / `FCM_BEARER` | for push | — | **Placeholder** static push credentials (see "Push"). |

```bash
docker run -d --name trail-stash -p 8787:8787 \
  -e TRAIL_STASH_SECRET_KEY="$STASH_SECRET" \
  -e TRAIL_STASH_PSK="$STASH_PSK" \
  -e TRAIL_STASH_RETENTION_HOURS=48 \
  trail-stash
```

## Step 3-K — deploy on Kubernetes with Helm (alternative to Steps 2–3)

Instead of `docker build`/`docker run`, pull the CI-published image and chart from GHCR. The chart
runs the stash as a single, stateless, in-memory pod with hardened defaults (non-root, read-only
root FS, `/healthz` probes). See `charts/trail-stash/README.md` for every value.

```bash
# 1. Create the identity + PSK secret ONCE, out of band (keeps the stable key out of Helm history).
kubectl create namespace trail-stash
kubectl -n trail-stash create secret generic trail-stash \
  --from-literal=TRAIL_STASH_SECRET_KEY="$STASH_SECRET" \
  --from-literal=TRAIL_STASH_PSK="$STASH_PSK"

# 2. Install the chart from GHCR (OCI). Pin image.tag to an immutable sha/semver in prod.
helm install trail-stash oci://ghcr.io/<owner>/charts/trail-stash \
  --namespace trail-stash \
  --set secret.existingSecret=trail-stash \
  --set image.tag=<sha-or-semver> \
  --set config.retentionHours=48
```

> **Single instance only.** The dial ticket is derived from `TRAIL_STASH_SECRET_KEY`; two pods with
> the same key fight over one iroh identity. The chart pins `replicas: 1` with a `Recreate` strategy
> — do not scale it up.

Expose the control API over TLS with your own ingress/reverse proxy pointing at
`svc/trail-stash:8787` (or set `ingress.enabled=true`). Then continue at **Step 6**. To publish the
image/chart yourself rather than consuming someone else's, see `PUBLISHING.md`.

## Step 4 — provision the dial ticket

The stash does not emit or persist its dial ticket. Provision
`EXPO_PUBLIC_TRAIL_STASH_TICKET` to the app out of band. It remains stable as long as
`TRAIL_STASH_SECRET_KEY` does not change.

## Step 5 — expose the control API over TLS

Put the container behind your reverse proxy at a stable hostname, e.g. `https://stash.<domain>` →
`http://127.0.0.1:8787`. Only the HTTP control API needs to be reachable by phones; the iroh QUIC
traffic goes over the relay (see "Networking"). Verify liveness:

```bash
curl -sf https://stash.<domain>/healthz && echo OK
```

## Step 6 — wire the app

In the repo-root `.env` (copy from `.env.example`):

```
EXPO_PUBLIC_TRAIL_STASH_URL=https://stash.<domain>
EXPO_PUBLIC_TRAIL_STASH_TICKET=<ticket from Step 4>
EXPO_PUBLIC_TRAIL_STASH_PSK=<same as TRAIL_STASH_PSK>
```

All three are required to enable the feature client-side; leaving any unset keeps the app on
peer-only reconciliation (the feature simply doesn't appear). Then **rebuild the custom dev client**
— this change added `expo-notifications` (native), so a JS-only reload is not enough:

```bash
bunx expo prebuild   # regenerates native projects with the expo-notifications plugin
# then EAS build / local run as usual (see AGENTS.md)
```

The feature is **opt-in**: in the app, Friends tab → "Offline delivery" toggle (only shown when the
stash is configured). Turning it on persists the choice, requests notification permission, grants
the stash replication of the user's + friends' trail namespaces, and subscribes the device's push
token for wake-ups.

## Step 7 — verify end to end

1. **Health:** `curl -sf https://stash.<domain>/healthz` → 200.
2. **PSK gate:** a `POST` without the bearer is rejected; with it, accepted:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://stash.<domain>/v1/namespaces \
     -H 'content-type: application/json' -d '{"read_ticket":"x"}'                       # → 401
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://stash.<domain>/v1/namespaces \
     -H "authorization: Bearer $STASH_PSK" -H 'content-type: application/json' \
     -d '{"read_ticket":"not-a-real-ticket"}'                                           # → 400 (past the gate)
   ```
3. **Reconciliation logic** is covered by the in-repo integration test (real two-node import →
   reconcile → wake): `cd infra/trail-stash/rust && cargo test --features live`.
4. **Real devices:** enable the toggle on two paired phones, move one while the other is fully
   backgrounded/offline, then bring the second online — its friend's missed trail should backfill.

## Push (optional, for prompt wake)

Without push, offline catch-up still works — it just waits for the phone's next foreground sync. To
wake a backgrounded phone promptly:

- Set `APNS_BUNDLE_ID` (= `com.unrealjune.streetcryptid`) and/or `FCM_PROJECT_ID`.
- Provide credentials. **Current limitation:** the sender reads a *static* bearer from
  `APNS_BEARER` / `FCM_BEARER` (placeholder `EnvCredentials`). Production needs short-lived
  credentials — an APNs ES256 JWT and an FCM OAuth2 access token, refreshed on a timer. That
  credential-minting is the one remaining piece (tracked in `PLAN.md`); the payload construction and
  send path are done and tested.

## Networking notes

- **Control API:** plain HTTP behind your TLS proxy. Rate-limit it at the proxy if exposed publicly.
- **iroh QUIC:** UDP, dynamic ports, works through the relay without inbound exposure. For faster
  direct dialing you may publish a UDP port, but it isn't required.
- **Relay:** the stash defaults to the n0 relays. For production, run/point it at your own
  authenticated relay (the same one in `EXPO_PUBLIC_IROH_RELAY_URLS`) to minimize metadata exposure.
  Set `config.relayUrls` in Helm (or `TRAIL_STASH_RELAY_URLS` as a comma-separated list for Docker).
  Put the optional bearer token in `secret.relayToken` or `TRAIL_STASH_RELAY_TOKEN`.

## Security checklist

- [ ] `TRAIL_STASH_SECRET_KEY` and `TRAIL_STASH_PSK` come from a secret manager, not the repo.
- [ ] `TRAIL_STASH_PSK` is set (startup warns if not) and matches `EXPO_PUBLIC_TRAIL_STASH_PSK`.
- [ ] Control API is behind TLS; consider proxy-level rate limiting.
- [ ] You accept the metadata exposure (which namespaces, timing, `namespace → push token` map). The
      stash never sees locations — envelopes are E2E encrypted and it's never wrapped for. Self-host
      to keep that metadata in your control.
- [ ] Retention window is set to your tolerance for data-at-rest vs. offline catch-up depth.

## Troubleshooting

- **`TRAIL_STASH_SECRET_KEY is required`** — set it (Step 1); it must be exactly 64 hex chars.
- **`control API is open` warning** — `TRAIL_STASH_PSK` is unset; set it to enable the gate.
- **App shows no toggle** — one of the three `EXPO_PUBLIC_TRAIL_STASH_*` vars is missing, or the dev
  client wasn't rebuilt after adding them.
- **Ticket changed after restart** — `TRAIL_STASH_SECRET_KEY` wasn't persisted/injected; set it and
  re-distribute the ticket.
- **Build fails on a native tool** — add it to the `apt-get install` line in the Dockerfile.

## For another Claude — quickstart

1. Read `PLAN.md` and `README.md` in this directory for design + API/security.
2. Generate `TRAIL_STASH_SECRET_KEY` and `TRAIL_STASH_PSK` (Step 1); store them in the user's secret
   manager — do **not** commit or print them into durable output.
3. Build + run the container (Steps 2–3); grab the ticket from logs (Step 4).
4. Put it behind the user's reverse proxy (Step 5); confirm `/healthz`.
5. Fill the three `EXPO_PUBLIC_TRAIL_STASH_*` vars and rebuild the dev client (Step 6).
6. Run the verification gates (Step 7), including `cargo test --features live` for the reconcile
   path. Report what passed with output; don't claim device delivery you didn't observe.
