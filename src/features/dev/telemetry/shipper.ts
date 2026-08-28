import { markShipped, takeUnshipped, type EventLogEntry } from './event-log';
import { fetchTransport, logPayload, spanPayload, type OtlpTransport } from './exporter';
import type { Attributes, FinishedSpan, LogRecord, LogSeverity, SpanContext } from './types';

/**
 * Ships the durable journal to the collector, with a cursor and retries.
 *
 * ## Why this replaced the in-memory exporter
 * The previous exporter queued spans in memory, POSTed on a timer, and **dropped the batch on any
 * failure** — one `console.warn`, then silence for the rest of the session. On a phone that is
 * working correctly that is invisible. On the phone we are actually trying to debug — woken in the
 * background, off Wi-Fi, on a flaky cellular link, frozen by the OS moments later — it means the
 * telemetry describing the failure is destroyed by the same conditions that caused it. Every
 * background bug we have chased was, in part, a reporting outage.
 *
 * The fix needed no new storage: `recordSpan` in `telemetry.ts` already mirrors every finished
 * span into the SQLite journal with its full attributes, events, trace context and links. The
 * journal was already the durable spine — nothing ever read it back out to the network. This does.
 *
 * ## Consequences worth knowing
 * - **Late data arrives with its ORIGINAL timestamps.** A wake at 03:12 that could not reach the
 *   collector until 09:40 appears at 03:12 in Tempo, which is the only way the timeline is worth
 *   reading.
 * - **Everything exported is sanitized**, because the journal sanitizes on write. That is a
 *   privacy improvement over the old direct path, which shipped raw attributes.
 * - **Entries recorded outside the tracer now reach the collector too.** `recordEventLog` calls in
 *   `location-sharing.ts` and `cryptid-generator.ts` (`ratchet`, `transport`, `generator`) were
 *   previously local-only.
 * - A row is marked shipped only after the collector has accepted it, so nothing is lost to a
 *   failed POST. The 10 000-row journal cap remains the hard bound: a phone offline long enough to
 *   roll the journal loses its oldest telemetry, which is bounded and acceptable.
 */

/** How many journal rows one drain may take. Bounds both the query and the payload size. */
export const SHIP_BATCH_SIZE = 250;

/**
 * How many batches one drain may send.
 *
 * A headless context has seconds, not minutes, and it is there to publish a location fix — not to
 * catch up on telemetry. A large backlog drains across several wakes rather than risking the OS
 * freezing us mid-publish. Same discipline as `HEADLESS_TEARDOWN_TIMEOUT_MS`.
 */
export const SHIP_MAX_BATCHES = 3;

/** Backoff after a failed drain: 30s, 1m, 2m, … capped. Keeps a dead collector cheap. */
export const SHIP_BACKOFF_BASE_MS = 30_000;
export const SHIP_BACKOFF_MAX_MS = 30 * 60_000;

export interface ShipperOptions {
  endpoint: string;
  /** Resource attributes stamped on every batch. Read at send time, so late-resolved ids apply. */
  resource: () => Attributes;
  transport?: OtlpTransport;
  now?: () => number;
  batchSize?: number;
  maxBatches?: number;
}

export interface Shipper {
  /**
   * Send what is queued, up to the budget. Resolves when the attempt is over — successfully or
   * not. Never rejects: telemetry must not be able to fail the code it is describing.
   */
  drain(): Promise<void>;
  /** Whether the circuit breaker is currently holding sends back, for `device.health`. */
  isBackingOff(): boolean;
}

interface StoredSpanDetails {
  duration_ms?: number;
  attributes?: Attributes;
  events?: { name: string; timeMs: number; attributes?: Attributes }[];
  /** Written by `recordSpan` — its presence is what marks a row as a span. */
  trace?: SpanContext;
  /** Written by `Telemetry.log` — the span a log line was correlated with, if any. */
  context?: SpanContext;
  parent_span_id?: string;
  links?: SpanContext[];
  status_message?: string;
}

function detailsOf(entry: EventLogEntry): StoredSpanDetails {
  const details = entry.details;
  return details && typeof details === 'object' ? (details as StoredSpanDetails) : {};
}

/**
 * A journal row describes a span if it carries a trace context — which only `recordSpan` writes.
 * Everything else (a `Telemetry.log` call, a direct `recordEventLog`) becomes a log record.
 */
function isSpanEntry(entry: EventLogEntry): boolean {
  const trace = detailsOf(entry).trace;
  return (
    typeof trace?.traceId === 'string' &&
    typeof trace?.spanId === 'string' &&
    trace.traceId.length === 32
  );
}

function toFinishedSpan(entry: EventLogEntry): FinishedSpan {
  const details = detailsOf(entry);
  const endMs = entry.timestamp;
  const duration = typeof details.duration_ms === 'number' ? details.duration_ms : 0;
  return {
    context: details.trace as SpanContext,
    ...(details.parent_span_id ? { parentSpanId: details.parent_span_id } : {}),
    name: entry.action,
    startMs: endMs - duration,
    endMs,
    attributes: details.attributes ?? {},
    events: (details.events ?? []).map((event) => ({
      name: event.name,
      timeMs: event.timeMs,
      attributes: event.attributes,
    })),
    links: details.links ?? [],
    // The journal stores 'ok' | 'error' | 'unset'; `recordSpan` already normalised a bare
    // completion to 'ok', so this round-trips.
    status: entry.status,
    ...(details.status_message ? { statusMessage: details.status_message } : {}),
  };
}

function toLogRecord(entry: EventLogEntry): LogRecord {
  const details = detailsOf(entry);
  const attributes: Attributes = {
    'event.action': entry.action,
    'event.category': entry.category,
    ...(entry.transport ? { 'event.transport': entry.transport } : {}),
    'launch.context': entry.launchContext,
    ...(details.attributes ?? {}),
  };
  return {
    timeMs: entry.timestamp,
    severity: entry.level as LogSeverity,
    body: entry.summary,
    attributes,
    // `Telemetry.log` stores the correlated span under `context`; `trace` belongs to spans and is
    // what `isSpanEntry` keys on, so a log row never has one.
    ...(details.context ? { context: details.context } : {}),
  };
}

export function createShipper(options: ShipperOptions): Shipper {
  const now = options.now ?? Date.now;
  const transport = options.transport ?? fetchTransport;
  const batchSize = options.batchSize ?? SHIP_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? SHIP_MAX_BATCHES;

  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  // Chain drains so two callers (a foreground resume racing a background wake) cannot take the
  // same rows twice, and so `await drain()` means "everything queued when I asked is out".
  let inflight: Promise<void> = Promise.resolve();
  let warned = false;

  function backoffMs(): number {
    const scaled = SHIP_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1);
    return Math.min(SHIP_BACKOFF_MAX_MS, scaled);
  }

  async function sendBatch(entries: EventLogEntry[]): Promise<void> {
    const resource = options.resource();
    const spans = entries.filter(isSpanEntry).map(toFinishedSpan);
    const logs = entries.filter((entry) => !isSpanEntry(entry)).map(toLogRecord);
    // Traces first: they are what the dashboards are built on, and if the second POST fails the
    // whole batch is retried anyway.
    if (spans.length > 0) {
      await transport(`${options.endpoint}/v1/traces`, spanPayload(resource, spans));
    }
    if (logs.length > 0) {
      await transport(`${options.endpoint}/v1/logs`, logPayload(resource, logs));
    }
  }

  async function runDrain(): Promise<void> {
    if (now() < nextAttemptAt) return;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      let entries: EventLogEntry[];
      try {
        entries = await takeUnshipped(batchSize);
      } catch {
        return;
      }
      if (entries.length === 0) {
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        return;
      }
      try {
        await sendBatch(entries);
      } catch (error) {
        consecutiveFailures += 1;
        nextAttemptAt = now() + backoffMs();
        if (!warned) {
          warned = true;
          console.warn(
            `[dev-telemetry] OTLP export to ${options.endpoint} failed; entries stay queued and will be retried (further failures silent):`,
            error
          );
        }
        return;
      }
      // Only now, and only for what the collector actually took.
      await markShipped(entries.map((entry) => entry.id));
      consecutiveFailures = 0;
      nextAttemptAt = 0;
      // A short batch means the queue is empty; stop rather than spend another round-trip.
      if (entries.length < batchSize) return;
    }
  }

  return {
    drain(): Promise<void> {
      // Two guarantees, and both matter on the background path.
      //
      // Chaining onto `inflight` means a foreground resume racing a background wake cannot take
      // the same rows twice, and that awaiting this means "everything queued when I asked is out".
      // The trailing catch means it can never REJECT: `Telemetry.flush()` is awaited in the
      // `finally` of every headless task, so a rejection here would escape into the task that was
      // only trying to report on itself — and in a headless context that surfaces as an unhandled
      // rejection with nobody left to catch it.
      inflight = inflight.then(runDrain, runDrain).catch(() => {});
      return inflight;
    },
    isBackingOff(): boolean {
      return now() < nextAttemptAt;
    },
  };
}
