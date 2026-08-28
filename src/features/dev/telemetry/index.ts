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
export {
  clearEventLog,
  EVENT_LOG_MAX_ENTRIES,
  eventLogEntryMatchesQuery,
  flushEventLog,
  getEventLog,
  loadEventLog,
  markShipped,
  recordEventLog,
  resetEventLogForTesting,
  subscribeEventLog,
  takeUnshipped,
  unshippedCount,
  withEventLogLaunchContext,
} from './event-log';
export { getBuildResource, getResolvedDeviceId, resolveDeviceId } from './identity';
export { createShipper } from './shipper';
export type { Shipper, ShipperOptions } from './shipper';
export type {
  EventLogEntry,
  EventLogLaunchContext,
  EventLogLevel,
  EventLogStatus,
  RecordEventLogEntry,
} from './event-log';
export type { Attributes, AttrValue, LogSeverity, Span, SpanContext, SpanStatus } from './types';

/**
 * Whether developer telemetry is compiled into this bundle at all.
 *
 * `true` here and `false` in `index.noop.ts` — the two files are swapped by a Metro resolver rule
 * (see `metro.config.js`), so this is a build-time constant, not a runtime setting. UI that only
 * exists to show telemetry (the Settings DEBUG section, the event-log viewer) gates on it, since
 * in a stripped build those surfaces would otherwise render permanently empty.
 */
export const DEV_TELEMETRY_ENABLED = true;
