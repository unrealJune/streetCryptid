import type { Attributes, AttrValue, FinishedSpan, LogRecord, LogSeverity } from './types';

/**
 * Minimal OTLP/HTTP JSON encoding. We deliberately do NOT use `@opentelemetry/sdk-trace-*`:
 * it assumes web/node globals, drags in ~200KB, and its batch processors misbehave in Hermes
 * headless JS contexts (timers may never fire again once the task returns). This is ~150 lines of
 * proto3-JSON mapping we fully control.
 *
 * This module is now pure encoding only. Batching, retry, and the decision about *when* to send
 * live in `shipper.ts`, which drains the durable journal — the previous in-module queue dropped
 * whole batches on the first failed POST, which meant a background wake with no network lost its
 * telemetry permanently. That was precisely the case worth seeing.
 */

/** Injectable transport so tests capture payloads without a network. Rejects on failure. */
export type OtlpTransport = (url: string, jsonBody: string) => Promise<void>;

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

/** OTLP `/v1/traces` request body for `batch`, stamped with `resource`. */
export function spanPayload(resource: Attributes, batch: readonly FinishedSpan[]): string {
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

/** OTLP `/v1/logs` request body for `batch`, stamped with `resource`. */
export function logPayload(resource: Attributes, batch: readonly LogRecord[]): string {
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

/** The real network transport. Rejects on a non-2xx so the shipper keeps the batch for a retry. */
export const fetchTransport: OtlpTransport = async (url, body) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  // A collector that answers 503 has NOT taken the batch. The old exporter ignored the status
  // entirely and discarded the payload regardless, so a struggling collector silently ate
  // telemetry that a retry would have delivered.
  if (!response.ok) {
    throw new Error(`OTLP export to ${url} failed: HTTP ${response.status}`);
  }
};
