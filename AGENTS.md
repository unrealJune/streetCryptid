# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

## Project conventions

- Package manager is **bun**. Use `bun install`, `bun add`, `bunx` — never npm/yarn/pnpm.
- Prefer the **just** recipes for common tasks (`just --list`). Run **`just check`**
  (typecheck + lint + format) before committing.
- Keep dependencies SDK-aligned: install native/Expo packages with
  `bunx expo install <pkg>` (not `bun add`) so versions match Expo SDK 57.
- Routes are file-based under `src/app/` (expo-router, typed routes). Import via the
  `@/*` → `src/*` path alias.
- `expo-env.d.ts` and `.expo/types/` are generated (git-ignored). Run `just start`
  once on a fresh clone before `just typecheck`.
- ESLint is pinned to v9 (eslint-config-expo@57's plugins are not yet ESLint 10 ready).

## Developer telemetry (OTEL)

**Read `infra/otel/README.md` before touching the location pipeline** — it documents the span
map, the `sc.*` join-key correlation model (entry-hash based; there is deliberately NO
end-to-end trace because payloads are E2E-encrypted), and the TraceQL cookbook for debugging
dropped location pings across devices and the trail-stash server.

Conventions when changing that code:

- Instrumentation lives at drop-decision points and stamps `sc.author` / `sc.seq` /
  `sc.entry_hash` / `sc.drop_reason`. JS uses `src/features/dev/telemetry/` (a hand-rolled
  OTLP-JSON client — do NOT add the OpenTelemetry JS SDK; it misbehaves in Hermes headless
  contexts). Rust (both `modules/iroh-location/rust` and the trail-stash repo) uses plain
  `tracing` spans; OTLP is a subscriber layer behind the `otel` cargo feature (default-on in
  the mobile crate; keep call sites free of `#[cfg]`).
- Everything is gated on `EXPO_PUBLIC_OTEL_ENDPOINT` (read statically — see the
  `stash-config.ts` convention). It must stay unset in the production EAS profile.
- Headless background code that records telemetry must flush before returning
  (`getTelemetry().flush()` / `flushDevTelemetry()`), or the OS freezes the process with the
  batch unexported.
- iOS Swift bindings regenerate only on macOS (`just bindgen-ios`); until run there, the native
  `configureTelemetry`/`flushTelemetry` exports are absent on iOS — always guard access
  (`typeof mod.configureTelemetry === 'function'`).
