import { getTelemetry } from './telemetry';
import type { LogSeverity } from './types';

/**
 * Mirror `console.warn` / `console.error` into the dev telemetry log pipeline (→ OTLP `/v1/logs` →
 * Loki), so the app's existing diagnostics (e.g. "[background-location] …") become searchable
 * alongside traces and carry the same resource attributes (`service.instance.id`, `os.name`, …).
 * The original console methods are ALWAYS still called. Inert unless telemetry is enabled, so
 * production builds (no `EXPO_PUBLIC_OTEL_ENDPOINT`) leave `console` untouched. Idempotent.
 *
 * Developer-only, like the rest of this folder: the collector is a developer-controlled endpoint and
 * these bodies are the same lines already printed to the dev console. Never enable in production.
 */

type ConsoleMethod = (...args: unknown[]) => void;

let originalWarn: ConsoleMethod | null = null;
let originalError: ConsoleMethod | null = null;
// Guards against feedback loops: telemetry export failures `console.warn` themselves, and any log
// enqueued from inside a wrapped call would otherwise re-enter the bridge.
let reentrant = false;

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function wrap(original: ConsoleMethod, severity: LogSeverity): ConsoleMethod {
  return (...args: unknown[]): void => {
    original(...args);
    if (reentrant) return;
    const body = args.map(formatArg).join(' ');
    // Skip the exporter's own failure notice so a broken collector can't feed itself.
    if (body.startsWith('[dev-telemetry]')) return;
    reentrant = true;
    try {
      getTelemetry().log(severity, body);
    } finally {
      reentrant = false;
    }
  };
}

/** Route `console.warn`/`console.error` through telemetry. Safe to call repeatedly (installs once). */
export function installConsoleTelemetryBridge(): void {
  if (originalWarn) return; // already installed
  if (!getTelemetry().enabled) return; // production / no endpoint → leave console untouched
  originalWarn = console.warn.bind(console) as ConsoleMethod;
  originalError = console.error.bind(console) as ConsoleMethod;
  console.warn = wrap(originalWarn, 'warn');
  console.error = wrap(originalError, 'error');
}

/** Restore the original console methods. Primarily a test seam. */
export function uninstallConsoleTelemetryBridge(): void {
  if (originalWarn) console.warn = originalWarn;
  if (originalError) console.error = originalError;
  originalWarn = null;
  originalError = null;
}
