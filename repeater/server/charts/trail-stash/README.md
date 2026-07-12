# trail-stash Helm chart

Deploys [`trail-stash`](../../README.md) — an always-on, ciphertext-blind,
stateless-in-memory iroh-docs replica + push-to-sync waker for offline encrypted-trail delivery.

## Install

```bash
# 1. Create the identity + control-API secret ONCE (keep it out of Helm history).
kubectl create namespace trail-stash
kubectl -n trail-stash create secret generic trail-stash \
  --from-literal=TRAIL_STASH_SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=TRAIL_STASH_PSK="$(openssl rand -hex 32)"

# 2. Install the chart from GHCR (OCI), pointing at that secret.
helm install trail-stash oci://ghcr.io/<owner>/charts/trail-stash \
  --namespace trail-stash \
  --set secret.existingSecret=trail-stash \
  --set image.tag=<sha-or-semver>
```

Then follow the post-install notes to copy `EXPO_PUBLIC_TRAIL_STASH_TICKET` out of the pod logs.

For a quick dev run you can skip the pre-made secret and let the chart generate it inline (the key
then lands in Helm history — do not do this in production):

```bash
helm install trail-stash oci://ghcr.io/<owner>/charts/trail-stash \
  --set secret.secretKey="$(openssl rand -hex 32)" \
  --set secret.psk="$(openssl rand -hex 32)"
```

## Design constraints baked into the chart

- **Single instance only.** The dial ticket is derived from `TRAIL_STASH_SECRET_KEY`; two pods
  with the same key = two nodes fighting over one iroh identity. `replicas` is pinned to 1 and the
  update `strategy` is `Recreate`. Horizontal scaling needs app-side changes and is not supported.
- **Stateless, in-memory.** No PVCs; a restart wipes all replicated ciphertext and devices
  re-register on their next opted-in sync. The root filesystem is mounted read-only (writable
  `/tmp` emptyDir only).
- **Never auto-generates the key.** A random key per upgrade would silently rotate the ticket and
  break every client, so a missing key is a hard template error.

## Key values

| Key | Default | Notes |
| --- | --- | --- |
| `image.repository` / `image.tag` | `ghcr.io/unrealjune/trail-stash` / `""` | Tag defaults to chart `appVersion`. Pin an immutable tag in prod. |
| `secret.existingSecret` | `""` | **Recommended.** Name of a Secret holding the keys below. |
| `secret.secretKey` | `""` | Inline `TRAIL_STASH_SECRET_KEY` (only when `existingSecret` empty). Required then. |
| `secret.psk` | `""` | Inline `TRAIL_STASH_PSK` (control-API bearer). Unset ⇒ open API (warned). |
| `secret.keys.*` | `TRAIL_STASH_*` etc. | Rename to match the keys in your `existingSecret`. |
| `config.retentionHours` | `48` | Prune window (app clamps 1–336). |
| `config.pruneIntervalMin` | `15` | Prune sweep cadence. |
| `config.relayUrls` | `[]` | Custom iroh relay URLs; empty uses the built-in n0 relay map. |
| `secret.relayToken` | `""` | Optional bearer token for every custom relay. Prefer an existing Secret. |
| `config.push.apnsBundleId` / `fcmProjectId` | `""` | Set to enable a push route; bearer comes from the Secret. |
| `service.type` / `service.port` | `ClusterIP` / `8787` | |
| `ingress.enabled` | `false` | Off — front it with your own TLS proxy. |
| `resources.limits.memory` | `512Mi` | Grows with retained ciphertext + subscriber count. |

See [`values.yaml`](values.yaml) for the complete, commented reference.

## Uninstall

```bash
helm uninstall trail-stash -n trail-stash
```

The `existingSecret` is not deleted (Helm didn't create it) — remove it yourself if you want to
rotate the identity.
