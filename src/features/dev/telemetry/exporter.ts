import type { Attributes, AttrValue, FinishedSpan, LogRecord, LogSeverity } from './types';

/**
 * Minimal OTLP/HTTP JSON exporter. We deliberately do NOT use `@opentelemetry/sdk-trace-*`:
 * it assumes web/node globals, drags in ~200KB, and its batch processors misbehave in Hermes
 * headless JS contexts (timers may never fire again once the task returns). This is ~150 lines of
 * proto3-JSON mapping we fully control, with an explicit `flush()` the background task awaits
 * before returning — the one guarantee an SDK can't give us.
 *
 * Failure policy: telemetry must never break the app. Export errors are swallowed after a single
 * `console.warn` per session; queued items are dropped on failure rather than retried (the
 * collector is a LAN dev tool; unreachable usually means "not running right now").
 */

/** Injectable transport so tests capture payloads without a network. */
export type OtlpTransport = (url: string, jsonBody: string) => Promise<void>;

export interface ExporterOptions {
  endpoint: string;
  /** Resource attributes stamped on every batch (service.name etc.). */
  resource: Attributes;
  transport?: OtlpTransport;
  /** Queue length that triggers an eager flush. Default 64. */
  maxQueue?: number;
  /** Timer flush interval (ms). Default 5000. */
  flushIntervalMs?: number;
  now?: () => number;
}

const SEVERITY_NUMBER: Record<LogSeverity, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

/** ms epoch → OTLP nanosecond decimal string. String concat: ms*1e6 exceeds 2^53. */
function nanos(ms: number): string {
  return `${Math.round(ms)}000000`;
}

function toAnyValue(value: AttrValue): Record<string, unknown> {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    default:
      // proto3 JSON encodes int64 as a decimal string; doubles stay numbers.
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
}

function toKeyValues(
  attrs: Attributes | undefined
): { key: string; value: Record<string, unknown> }[] {
  if (!attrs) return [];
  const out: { key: string; value: Record<string, unknown> }[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out.push({ key, value: toAnyValue(value) });
  }
  return out;
}

const SCOPE = { name: 'streetcryptid.dev-telemetry', version: '1' };

export interface OtlpExporter {
  enqueueSpan(span: FinishedSpan): void;
  enqueueLog(record: LogRecord): void;
  /** Serialize + POST everything queued. Awaited by background tasks before they return. */
  flush(): Promise<void>;
  /** Merge late-known resource attributes (e.g. service.instance.id after node start). */
  setResourceAttributes(attrs: Attributes): void;
}

export function createOtlpExporter(options: ExporterOptions): OtlpExporter {
  const maxQueue = options.maxQueue ?? 64;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const resource: Attributes = { ...options.resource };
  const transport: OtlpTransport =
    options.transport ??
    (async (url, body) => {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    });

  let spans: FinishedSpan[] = [];
  let logs: LogRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let warned = false;
  let inflight: Promise<void> = Promise.resolve();

  function scheduleFlush(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  }

  function spanPayload(batch: FinishedSpan[]): string {
    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: toKeyValues(resource) },
          scopeSpans: [
            {
              scope: SCOPE,
              spans: batch.map((s) => ({
                traceId: s.context.traceId,
                spanId: s.context.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                kind: 1, // INTERNAL — the transport topology is expressed via links/attrs instead
                startTimeUnixNano: nanos(s.startMs),
                endTimeUnixNano: nanos(s.endMs),
                attributes: toKeyValues(s.attributes),
                events: s.events.map((e) => ({
                  timeUnixNano: nanos(e.timeMs),
                  name: e.name,
                  attributes: toKeyValues(e.attributes),
                })),
                links: s.links.map((l) => ({ traceId: l.traceId, spanId: l.spanId })),
                status:
                  s.status === 'error'
                    ? { code: 2, ...(s.statusMessage ? { message: s.statusMessage } : {}) }
                    : s.status === 'ok'
                      ? { code: 1 }
                      : {},
              })),
            },
          ],
        },
      ],
    });
  }

  function logPayload(batch: LogRecord[]): string {
    return JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: toKeyValues(resource) },
          scopeLogs: [
            {
              scope: SCOPE,
              logRecords: batch.map((r) => ({
                timeUnixNano: nanos(r.timeMs),
                severityNumber: SEVERITY_NUMBER[r.severity],
                severityText: r.severity.toUpperCase(),
                body: { stringValue: r.body },
                attributes: toKeyValues(r.attributes),
                ...(r.context ? { traceId: r.context.traceId, spanId: r.context.spanId } : {}),
              })),
            },
          ],
        },
      ],
    });
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    // Chain onto the previous flush so payloads arrive in order and callers can await "everything
    // enqueued so far is out".
    inflight = inflight.then(async () => {
      const spanBatch = spans;
      const logBatch = logs;
      spans = [];
      logs = [];
      try {
        if (spanBatch.length > 0) {
          await transport(`${options.endpoint}/v1/traces`, spanPayload(spanBatch));
        }
        if (logBatch.length > 0) {
          await transport(`${options.endpoint}/v1/logs`, logPayload(logBatch));
        }
      } catch (err) {
        if (!warned) {
          warned = true;
          console.warn(
            `[dev-telemetry] OTLP export to ${options.endpoint} failed (further failures silent):`,
            err
          );
        }
      }
    });
    return inflight;
  }

  return {
    enqueueSpan(span: FinishedSpan): void {
      spans.push(span);
      if (spans.length >= maxQueue) void flush();
      else scheduleFlush();
    },
    enqueueLog(record: LogRecord): void {
      logs.push(record);
      if (logs.length >= maxQueue) void flush();
      else scheduleFlush();
    },
    flush,
    setResourceAttributes(attrs: Attributes): void {
      Object.assign(resource, attrs);
    },
  };
}
