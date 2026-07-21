/** Shared types for the dev telemetry mini-client (see README.md in this directory). */

/** OTLP-representable attribute value. Objects/arrays are JSON-stringified by the exporter. */
export type AttrValue = string | number | boolean;

export type Attributes = Record<string, AttrValue | undefined>;

/** The propagable identity of a span — what a `traceparent` carries. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes?: Attributes;
}

/** A finished span as handed to the exporter. */
export interface FinishedSpan {
  context: SpanContext;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs: number;
  attributes: Attributes;
  events: SpanEvent[];
  links: SpanContext[];
  status: SpanStatus;
  statusMessage?: string;
}

/**
 * The live span handle instrumentation code holds. Every method is safe to call in any state
 * (local-only telemetry has the same shape), so call sites never branch.
 */
export interface Span {
  readonly context: SpanContext;
  setAttribute(key: string, value: AttrValue | undefined): void;
  setAttributes(attrs: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  /** Marks the span failed and records the error message as an event. */
  recordError(error: unknown): void;
  setStatus(status: SpanStatus, message?: string): void;
  /** Finish and enqueue for export. Idempotent — second calls are ignored. */
  end(): void;
}

/** OTLP severity numbers (subset we use). */
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  timeMs: number;
  severity: LogSeverity;
  body: string;
  attributes?: Attributes;
  /** Correlate the log with a span when one is in scope. */
  context?: SpanContext;
}
