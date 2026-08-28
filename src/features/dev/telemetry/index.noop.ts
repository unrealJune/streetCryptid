import type { Attributes, LogSeverity, Span, SpanContext, SpanStatus } from './types';
import type { OtelConfig } from './otel-config';
import type {
  EventLogEntry,
  EventLogLaunchContext,
  EventLogLevel,
  EventLogStatus,
  RecordEventLogEntry,
} from './event-log';
import type { Shipper, ShipperOptions } from './shipper';
import type { StartSpanOptions, Telemetry } from './telemetry';

/**
 * The stripped build's telemetry: every export of `index.ts`, doing nothing.
 *
 * ## Why a swapped module rather than a runtime flag
 * `metro.config.js` aliases `@/features/dev/telemetry` to this file unless
 * `EXPO_PUBLIC_DEV_TELEMETRY=1`. Because every consumer imports the barrel, that one resolver rule
 * removes the *entire* graph from the bundle — the exporter, the shipper, the SQLite journal, the
 * console bridge, the device snapshot — instead of shipping it all behind an `if` that a typo in
 * an env var could flip on. A runtime gate leaves the code, the database, and the network paths in
 * the binary; this leaves nothing to enable.
 *
 * This is deliberately the same shape as the native core's `otel` cargo feature, whose
 * `--no-default-features` build swaps `telemetry.rs`'s `imp` module for stubs with an identical
 * UniFFI surface. JS and Rust now strip the same way, for the same reason.
 *
 * ## The rule this file lives by
 * It must export exactly what `index.ts` exports, with the same types. `index-parity.test.ts`
 * enforces that, because the failure mode otherwise is a release-only bundling error that no
 * development build can reproduce — the single worst kind of bug to ship this mechanism with.
 */

export type { OtelConfig };
export type { StartSpanOptions, Telemetry };
export type { Shipper, ShipperOptions };
export type {
  EventLogEntry,
  EventLogLaunchContext,
  EventLogLevel,
  EventLogStatus,
  RecordEventLogEntry,
};
export type { Attributes, AttrValue, LogSeverity, Span, SpanContext, SpanStatus } from './types';

/** No endpoint is ever configured in a stripped build — that is the point of it. */
export function getOtelConfig(): OtelConfig | null {
  return null;
}

// One shared no-op span. Every method on `Span` is documented as safe to call in any state, so
// call sites never branch on whether telemetry is live — and here, none of them do anything.
const NOOP_CONTEXT: SpanContext = { traceId: '0'.repeat(32), spanId: '0'.repeat(16) };

const NOOP_SPAN: Span = {
  context: NOOP_CONTEXT,
  setAttribute(): void {},
  setAttributes(): void {},
  addEvent(): void {},
  recordError(): void {},
  setStatus(): void {},
  end(): void {},
};

const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  startSpan(): Span {
    return NOOP_SPAN;
  },
  async withSpan<T>(
    _name: string,
    _options: StartSpanOptions,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    // Still runs the work — this wraps real behaviour, it does not only observe it.
    return fn(NOOP_SPAN);
  },
  log(): void {},
  setResourceAttributes(): void {},
  async flush(): Promise<void> {},
};

export function createTelemetry(): Telemetry {
  return NOOP_TELEMETRY;
}

export function getTelemetry(): Telemetry {
  return NOOP_TELEMETRY;
}

export function setTelemetryForTesting(): void {}

export function traceparentFor(): string {
  // An all-zero trace id is invalid per W3C, so a receiver treats this as "no parent" — which is
  // exactly right. Callers gate on `telemetry.enabled` anyway before sending one across the
  // bridge.
  return `00-${NOOP_CONTEXT.traceId}-${NOOP_CONTEXT.spanId}-00`;
}

export function parseTraceparent(): SpanContext | null {
  return null;
}

export async function getSystemSnapshot(): Promise<Attributes> {
  return {};
}

export function attachSystemSnapshot(): void {}

export function getDeviceResource(): Attributes {
  return {};
}

export function getBuildResource(): Attributes {
  return {};
}

export function getResolvedDeviceId(): string | undefined {
  return undefined;
}

export async function resolveDeviceId(): Promise<string | undefined> {
  return undefined;
}

export function installConsoleTelemetryBridge(): void {}

export function uninstallConsoleTelemetryBridge(): void {}

export function createShipper(_options: ShipperOptions): Shipper {
  return {
    async drain(): Promise<void> {},
    isBackingOff(): boolean {
      return false;
    },
  };
}

export const EVENT_LOG_MAX_ENTRIES = 0;

export function recordEventLog(input: RecordEventLogEntry): EventLogEntry {
  // Returned rather than thrown away because `recordEventLog` is documented to hand the entry
  // back; a caller reading `.id` must not crash in a stripped build.
  return {
    id: '',
    timestamp: input.timestamp ?? 0,
    level: input.level ?? 'info',
    category: input.category,
    action: input.action,
    summary: input.summary,
    status: input.status ?? 'unset',
    launchContext: 'foreground',
    details: {},
  };
}

export function getEventLog(): EventLogEntry[] {
  return [];
}

export async function loadEventLog(): Promise<EventLogEntry[]> {
  return [];
}

export function subscribeEventLog(listener: (entries: EventLogEntry[]) => void): () => void {
  listener([]);
  return () => {};
}

export async function flushEventLog(): Promise<void> {}

export async function clearEventLog(): Promise<void> {}

export function resetEventLogForTesting(): void {}

export function eventLogEntryMatchesQuery(): boolean {
  return false;
}

export async function withEventLogLaunchContext<T>(
  _context: EventLogLaunchContext,
  operation: () => Promise<T>
): Promise<T> {
  // The wrapped operation is the background pipeline itself, not instrumentation.
  return operation();
}

export async function takeUnshipped(): Promise<EventLogEntry[]> {
  return [];
}

export async function markShipped(): Promise<void> {}

export async function unshippedCount(): Promise<number> {
  return 0;
}

/** See the note on the real barrel's export: this is the stripped build. */
export const DEV_TELEMETRY_ENABLED = false;
