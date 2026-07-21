import { createOtlpExporter, type OtlpExporter, type OtlpTransport } from './exporter';
import { flushEventLog, recordEventLog } from './event-log';
import { newSpanId, newTraceId } from './ids';
import { getOtelConfig } from './otel-config';
import { getDeviceResource } from './resource';
import type {
  Attributes,
  AttrValue,
  FinishedSpan,
  LogSeverity,
  Span,
  SpanContext,
  SpanEvent,
  SpanStatus,
} from './types';

/**
 * The tracer facade every instrumented code path talks to. Two implementations behind one shape:
 * a remote-exporting one when `EXPO_PUBLIC_OTEL_ENDPOINT` is configured (dev/preview builds), and
 * a local-journal-only one otherwise. Context propagation is EXPLICIT (pass `parent`), not ambient:
 * Hermes has no reliable AsyncLocalStorage, and explicit parents keep headless paths honest.
 */

export interface StartSpanOptions {
  parent?: SpanContext;
  links?: SpanContext[];
  attributes?: Attributes;
}

export interface Telemetry {
  readonly enabled: boolean;
  startSpan(name: string, options?: StartSpanOptions): Span;
  /**
   * Run `fn` inside a span: resolves ⇒ status ok, throws ⇒ status error + rethrow. The span is
   * passed in so `fn` can attach attributes/events and parent further spans.
   */
  withSpan<T>(name: string, options: StartSpanOptions, fn: (span: Span) => Promise<T>): Promise<T>;
  log(severity: LogSeverity, body: string, attributes?: Attributes, context?: SpanContext): void;
  /** Merge late-known resource attributes (service.instance.id once the node identity exists). */
  setResourceAttributes(attrs: Attributes): void;
  /** Await export of everything recorded so far. Headless tasks MUST await this before returning. */
  flush(): Promise<void>;
}

export interface CreateTelemetryOptions {
  endpoint?: string;
  resource?: Attributes;
  transport?: OtlpTransport;
  now?: () => number;
}

function categoryFor(name: string): string {
  if (/pair|ble|bump|profile/i.test(name)) return 'pairing';
  if (
    /transport|relay|gossip|docs|trail|stash|fix|outbox|engine|background|bg\.|push/i.test(name)
  ) {
    return 'transport';
  }
  return 'system';
}

function transportFor(name: string): string | undefined {
  if (/stash/i.test(name)) return 'stash';
  if (/gossip/i.test(name)) return 'gossip';
  if (/docs|trail|backfill/i.test(name)) return 'durable trail';
  if (/ble|bump/i.test(name)) return 'BLE';
  if (/publish|fix|outbox|engine/i.test(name)) return 'iroh';
  return undefined;
}

function recordSpan(span: FinishedSpan): void {
  const dropReason = span.attributes['sc.drop_reason'];
  const duration = Math.max(0, span.endMs - span.startMs);
  const status = span.status === 'unset' && !dropReason ? 'ok' : span.status;
  recordEventLog({
    timestamp: span.endMs,
    level: span.status === 'error' ? 'error' : dropReason ? 'warn' : 'debug',
    category: categoryFor(span.name),
    action: span.name,
    summary: dropReason
      ? `${span.name}: ${String(dropReason)}`
      : `${span.name} ${status === 'error' ? 'failed' : 'completed'} in ${duration}ms`,
    status,
    transport: transportFor(span.name),
    details: {
      duration_ms: duration,
      attributes: span.attributes,
      events: span.events,
      trace: span.context,
      parent_span_id: span.parentSpanId,
      links: span.links,
      status_message: span.statusMessage,
    },
  });
}

/** Build a live telemetry instance. Exported for tests; app code uses {@link getTelemetry}. */
export function createTelemetry(options: CreateTelemetryOptions): Telemetry {
  const now = options.now ?? Date.now;
  const exporter: OtlpExporter | undefined = options.endpoint
    ? createOtlpExporter({
        endpoint: options.endpoint,
        resource: { 'service.name': 'streetcryptid-app', ...options.resource },
        transport: options.transport,
        now,
      })
    : undefined;

  function startSpan(name: string, opts: StartSpanOptions = {}): Span {
    const context: SpanContext = {
      traceId: opts.parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
    };
    const attributes: Attributes = { ...opts.attributes };
    const events: SpanEvent[] = [];
    const startMs = now();
    let status: SpanStatus = 'unset';
    let statusMessage: string | undefined;
    let ended = false;

    return {
      context,
      setAttribute(key: string, value: AttrValue | undefined): void {
        attributes[key] = value;
      },
      setAttributes(attrs: Attributes): void {
        Object.assign(attributes, attrs);
      },
      addEvent(eventName: string, eventAttrs?: Attributes): void {
        events.push({ name: eventName, timeMs: now(), attributes: eventAttrs });
      },
      recordError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        status = 'error';
        statusMessage = message;
        events.push({
          name: 'exception',
          timeMs: now(),
          attributes: { 'exception.message': message },
        });
      },
      setStatus(next: SpanStatus, message?: string): void {
        status = next;
        statusMessage = message;
      },
      end(): void {
        if (ended) return;
        ended = true;
        const finished: FinishedSpan = {
          context,
          parentSpanId: opts.parent?.spanId,
          name,
          startMs,
          endMs: now(),
          attributes,
          events,
          links: opts.links ?? [],
          status,
          statusMessage,
        };
        recordSpan(finished);
        exporter?.enqueueSpan(finished);
      },
    };
  }

  return {
    enabled: exporter !== undefined,
    startSpan,
    async withSpan<T>(
      name: string,
      opts: StartSpanOptions,
      fn: (span: Span) => Promise<T>
    ): Promise<T> {
      const span = startSpan(name, opts);
      try {
        const result = await fn(span);
        span.setStatus('ok');
        return result;
      } catch (err) {
        span.recordError(err);
        throw err;
      } finally {
        span.end();
      }
    },
    log(severity, body, attributes, context): void {
      const timeMs = now();
      recordEventLog({
        timestamp: timeMs,
        level: severity,
        category: categoryFor(body),
        action: 'log',
        summary: body,
        status: severity === 'error' ? 'error' : 'unset',
        details: { attributes, context },
      });
      exporter?.enqueueLog({ timeMs, severity, body, attributes, context });
    },
    setResourceAttributes(attrs: Attributes): void {
      exporter?.setResourceAttributes(attrs);
    },
    async flush(): Promise<void> {
      await Promise.all([exporter?.flush() ?? Promise.resolve(), flushEventLog()]);
    },
  };
}

let singleton: Telemetry | undefined;

/**
 * The app-wide telemetry instance. Reads the endpoint once; the same instance serves the mounted
 * app and (in its own JS context) the headless background task.
 */
export function getTelemetry(): Telemetry {
  if (singleton === undefined) {
    const config = getOtelConfig();
    singleton = createTelemetry({
      endpoint: config?.endpoint,
      resource: getDeviceResource(),
    });
  }
  return singleton;
}

/** Test seam: replace/clear the singleton. */
export function setTelemetryForTesting(instance: Telemetry | undefined): void {
  singleton = instance;
}

/** Serialize a span's context as a W3C `traceparent` (always sampled — dev-only telemetry). */
export function traceparentFor(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}

/** Parse a W3C `traceparent` into a linkable {@link SpanContext}; null when malformed. */
export function parseTraceparent(header: string | null | undefined): SpanContext | null {
  if (!header) return null;
  const parts = header.trim().split('-');
  if (parts.length < 4) return null;
  const [, traceId, spanId] = parts;
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === '0'.repeat(32)) return null;
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === '0'.repeat(16)) return null;
  return { traceId, spanId };
}
