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

/**
 * ms epoch → OTLP nanosecond decimal string. String concat: ms*1e6 exceeds 2^53.
 *
 * A non-finite input would encode as `"NaN000000"`, which the collector rejects with a 400 — and a
 * row the collector can never accept used to sit at the head of the journal forever, silencing
 * every row behind it. Zero is a wrong timestamp; a poisoned journal is a silent phone.
 */
function nanos(ms: number): string {
  return Number.isFinite(ms) ? `${Math.round(ms)}000000` : '0';
}

function toAnyValue(value: AttrValue): Record<string, unknown> {
  switch (typeof value) {
    case 'string':
      return { stringValue: value };
    case 'boolean':
      return { boolValue: value };
    default:
      // proto3 JSON encodes int64 as a decimal string; doubles stay numbers. Only a SAFE integer is
      // an int: `String(1e21)` is "1e+21", which is not an int64 and fails the whole request — as
      // does a NaN or Infinity `doubleValue`, which JSON cannot even spell.
      if (!Number.isFinite(value)) return { stringValue: String(value) };
      return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
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

/**
 * A collector answer that says the request itself is bad, so sending it again cannot succeed.
 *
 * Distinct from every other failure because the shipper must treat it differently: a 503 or a
 * dropped connection is retried, but retrying a 400 or 413 is a loop, and because the journal
 * drains oldest-first it is a loop that blocks every row queued behind it.
 */
export class OtlpRejectedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number
  ) {
    super(`OTLP export to ${url} rejected: HTTP ${status}`);
    this.name = 'OtlpRejectedError';
  }
}

/** 4xx other than 408 (timeout) and 429 (rate limit), which are about timing, not the payload. */
export function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
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
    if (isPermanentRejection(response.status)) throw new OtlpRejectedError(url, response.status);
    throw new Error(`OTLP export to ${url} failed: HTTP ${response.status}`);
  }
};
