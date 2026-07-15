/**
 * Developer-only OpenTelemetry export (traces + logs) for debugging the location pipeline —
 * "which device/hop dropped my ping". Inert unless `EXPO_PUBLIC_OTEL_ENDPOINT` is set (dev and
 * preview builds only; see `infra/otel/README.md` for the collector stack and the correlation
 * model that joins app ⇄ trail-stash ⇄ other devices on `sc.entry_hash` / (`sc.author`, `sc.seq`)).
 */

export { getOtelConfig } from './otel-config';
export type { OtelConfig } from './otel-config';
export {
  createTelemetry,
  getTelemetry,
  parseTraceparent,
  setTelemetryForTesting,
  traceparentFor,
} from './telemetry';
export type { StartSpanOptions, Telemetry } from './telemetry';
export { attachSystemSnapshot, getSystemSnapshot } from './snapshot';
export { getDeviceResource } from './resource';
export { installConsoleTelemetryBridge, uninstallConsoleTelemetryBridge } from './console-bridge';
export type { Attributes, AttrValue, LogSeverity, Span, SpanContext, SpanStatus } from './types';
