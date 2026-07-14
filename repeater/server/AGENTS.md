# trail-stash — agent notes

An always-on, ciphertext-blind, fully in-memory iroh-docs replica + push-to-sync waker for
streetCryptid's offline trail delivery. Read `README.md` first; `PLAN.md` holds the roadmap.

## Build & test

- `cd rust && cargo test` — the PURE core (no iroh/tokio). Must stay dependency-light and green
  on any host; never move iroh-touching code out of the `live` feature.
- `cargo check --features live` — the real node + axum control API.
- `cargo test --features otel` — `live` + developer telemetry (also runs the live two-node
  integration test).
- The Docker image (and GHCR CI, which builds via `rust/Dockerfile`) ships
  `--features live,otel`.

## Developer telemetry (the `otel` feature)

- Runtime-gated by `OTEL_EXPORTER_OTLP_ENDPOINT`: unset ⇒ exactly the pre-telemetry code path.
  All OTLP machinery lives in `rust/src/telemetry.rs`; instrumentation elsewhere is plain
  `tracing` spans/events — keep call sites free of `#[cfg(feature = "otel")]` except at the few
  documented plumbing points (router layer, push-payload traceparent embedding).
- Correlation with the phones is by span attributes, not trace context: `sc.entry_hash`
  (short blobs content hash), `sc.author`, `sc.seq`, `sc.namespace`. The streetCryptid repo's
  `infra/otel/README.md` documents the full cross-device model, span map, and TraceQL cookbook —
  read it before renaming any span or `sc.*` attribute; the names are load-bearing on both ends.
- Real trace context exists in exactly two places: inbound `traceparent` on the control API
  (middleware in `telemetry.rs`), and outbound `traceparent` inside the silent push payload
  (`waker.rs`), which the phone's `push.wake` span links to.
- Redaction: exported OTLP log **bodies** pass `log_redaction::redact_log_line` (see
  `RedactingLogProcessor`); attributes are not redacted — the endpoint must always be a
  developer-controlled collector. Preserve this invariant when touching the log pipeline.

## Conventions

- Meticulous rationale-heavy doc comments; match them.
- Never log full push tokens (`PushSubscription::redacted`) or full identity keys; `sc.*`
  telemetry ids are 10-hex-char truncations for the same reason.
- Helm chart in `charts/trail-stash/` (`config.otel.*` values); single replica only — the iroh
  identity cannot be shared between pods.
