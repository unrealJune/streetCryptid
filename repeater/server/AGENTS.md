# trail-stash — agent notes

An always-on, ciphertext-blind, fully in-memory iroh-docs replica + push-to-sync waker for
streetCryptid's offline trail delivery, and the Linux/Docker repeater (`Storage::MemoryRepeater`).
Read `README.md` first; `PLAN.md` holds the roadmap.

This directory was the separate `unrealJune/trail-stash` repository until 2026-11-11
(`docs/MONOREPO.md`); its history came with it. The crate is a member of the repository's root
Cargo workspace, beside the roster/wire crate it shares with the phone (`../protocol`) and the
Windows repeater's host that embeds it (`../windows/host`). The root `AGENTS.md` still applies.

## Build & test

Always name the packages: the workspace also holds the phone's crates, and features on a
workspace-wide build unify across all of it. `just server::<recipe>` wraps these.

- `cargo test -p streetcryptid-repeater -p trail-stash` — the PURE core (no iroh/tokio). Must stay
  dependency-light and green on any host; never move iroh-touching code out of the `live` feature.
- `cargo check -p trail-stash --features live` — the real node + axum control API.
- `cargo test -p trail-stash --features otel` — `live` + developer telemetry (also runs the live
  two-node integration test).
- The Docker image (`Dockerfile`, built from the repository root) ships `--features live,otel`
  under the workspace's `server-release` profile.

## Releases

A push to main that touches the server, the protocol or the workspace's shared files publishes
`:latest`, `:sha-<short>` and chart `0.0.0-<short>`, which production tracks, and cuts a
`server-vX.Y.Z` when a Conventional Commit since the last one ships something
(`.github/workflows/release-repeater-server.yml`, `scripts/next-repeater-version.sh server`).
So commit types matter here: `fix(server)`/`feat(server)` release, `docs`/`chore`/`refactor`/
`test`/`build`/`ci` do not. The Windows host links this crate, so a server release is a Windows
release too.

## Developer telemetry (the `otel` feature)

- Runtime-gated by `OTEL_EXPORTER_OTLP_ENDPOINT`: unset ⇒ exactly the pre-telemetry code path.
  All OTLP machinery lives in `src/telemetry.rs`; instrumentation elsewhere is plain
  `tracing` spans/events — keep call sites free of `#[cfg(feature = "otel")]` except at the few
  documented plumbing points (router layer, push-payload traceparent embedding).
- Correlation with the phones is by span attributes, not trace context: `sc.entry_hash`
  (short blobs content hash), `sc.author`, `sc.seq`, `sc.namespace`.
  [`infra/otel/README.md`](../../infra/otel/README.md) documents the full cross-device model, span
  map, and TraceQL cookbook —
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
