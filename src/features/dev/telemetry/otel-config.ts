/**
 * Developer-only OTEL export config. Resolved from the environment at build time:
 * `EXPO_PUBLIC_OTEL_ENDPOINT` names the OTLP/HTTP base (e.g. `http://192.168.1.10:4318` — the
 * collector in `infra/otel/`). Unset (the production profile) ⇒ `null` ⇒ every telemetry call in
 * the app is an inert no-op; set (development/preview profiles + local `.env`) ⇒ spans + logs ship.
 *
 * `process.env.EXPO_PUBLIC_*` must be read as static member expressions (not aliased through a
 * parameter) so `babel-preset-expo` inlines the literal at build time — a Hermes release bundle has
 * no populated `process.env` to read at runtime. See `stash-config.ts` for the same convention.
 */

export interface OtelConfig {
  /** OTLP/HTTP base URL without trailing slash; `/v1/traces` + `/v1/logs` are appended. */
  endpoint: string;
}

export function getOtelConfig(): OtelConfig | null {
  const raw = process.env.EXPO_PUBLIC_OTEL_ENDPOINT?.trim();
  if (!raw) return null;
  return { endpoint: raw.endsWith('/') ? raw.slice(0, -1) : raw };
}
