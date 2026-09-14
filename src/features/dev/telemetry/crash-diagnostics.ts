import { getTelemetry } from './telemetry';

/**
 * Forward the OS's own crash / hang diagnostics into the trace store.
 *
 * The native half (`MetricKitDiagnostics.swift`) subscribes to MetricKit at module creation and
 * spools payloads to a file, because they arrive shortly after launch on a background queue and
 * are never redelivered. This drains that spool once per foreground launch and emits one
 * `ios.diagnostic` span per entry.
 *
 * It is the only signal here the app did not write about itself, which is exactly why it matters:
 * `app.previous_run` can say the process went away while someone was looking at it, and `ui.hang`
 * can say frames stopped, but neither can say whether the cause was a signal, a watchdog or the
 * memory killer. `termination_reason` says it in words.
 */

/** What the native side hands over, once parsed. Everything is optional by kind. */
export interface OsDiagnostic {
  kind: string;
  app_version?: string;
  app_build?: string;
  os_version?: string;
  device_type?: string;
  /** Hang / launch duration, or absent for a crash. */
  duration_ms?: number;
  termination_reason?: string;
  exception_type?: number;
  exception_code?: number;
  signal?: number;
  vm_region?: string;
  cpu_time_ms?: number;
  sampled_time_ms?: number;
  writes_bytes?: number;
  window_begin_ms?: number;
  window_end_ms?: number;
  received_ms?: number;
  frames?: string[];
}

/** The minimal shape this module is willing to act on. */
function parse(line: string): OsDiagnostic | null {
  try {
    const value = JSON.parse(line) as Partial<OsDiagnostic>;
    return typeof value.kind === 'string' ? (value as OsDiagnostic) : null;
  } catch {
    return null;
  }
}

/**
 * The span attributes for one diagnostic.
 *
 * Frames are joined into one string rather than sent as an array because a span attribute is a
 * scalar in our OTLP encoder, and because the whole point of the frame list is to be pasted into
 * a symbolicator in order. Capped a second time here: the native side already bounds it, and this
 * is the boundary where a malformed payload would otherwise become an unbounded span.
 */
export function diagnosticAttributes(diagnostic: OsDiagnostic): Record<string, string | number> {
  const attributes: Record<string, string | number> = { kind: diagnostic.kind };
  const copyNumber = (key: keyof OsDiagnostic, as: string): void => {
    const value = diagnostic[key];
    if (typeof value === 'number' && Number.isFinite(value)) attributes[as] = Math.round(value);
  };
  const copyString = (key: keyof OsDiagnostic, as: string): void => {
    const value = diagnostic[key];
    if (typeof value === 'string' && value) attributes[as] = value.slice(0, 256);
  };

  copyNumber('duration_ms', 'duration_ms');
  copyNumber('exception_type', 'exception_type');
  copyNumber('exception_code', 'exception_code');
  copyNumber('signal', 'signal');
  copyNumber('cpu_time_ms', 'cpu_time_ms');
  copyNumber('sampled_time_ms', 'sampled_time_ms');
  copyNumber('writes_bytes', 'writes_bytes');
  copyString('termination_reason', 'termination_reason');
  copyString('vm_region', 'vm_region');
  // The build that died, which is NOT necessarily the build reporting it — a diagnostic survives
  // the upgrade that was installed to fix it, and attributing it to the current build would make
  // the fix look like the cause.
  copyString('app_version', 'diag.app_version');
  copyString('app_build', 'diag.app_build');
  copyString('os_version', 'diag.os_version');
  copyString('device_type', 'diag.device_type');

  if (Array.isArray(diagnostic.frames) && diagnostic.frames.length > 0) {
    const frames = diagnostic.frames.filter((f) => typeof f === 'string').slice(0, 48);
    if (frames.length > 0) {
      attributes.frames = frames.join('\n');
      attributes.frame_count = frames.length;
    }
  }
  // When the OS says the app died, it is telling us about a window, and the window is how you
  // line it up against the run that went dark.
  copyNumber('window_begin_ms', 'window_begin_ms');
  copyNumber('window_end_ms', 'window_end_ms');
  return attributes;
}

interface DiagnosticSource {
  takeCrashDiagnostics?(): Promise<string[]>;
}

/**
 * Drain and report. Safe to call anywhere: absent on Android and on any iOS binary older than the
 * native half, which is the documented reason every optional native export is probed rather than
 * called (a phone can run an older binary than the JS bundle).
 *
 * Returns how many were reported, for tests and for the caller's own logging.
 */
export async function reportOsDiagnostics(source: DiagnosticSource | null): Promise<number> {
  if (!source || typeof source.takeCrashDiagnostics !== 'function') return 0;
  let lines: string[];
  try {
    lines = await source.takeCrashDiagnostics();
  } catch {
    return 0;
  }
  if (!Array.isArray(lines) || lines.length === 0) return 0;

  const telemetry = getTelemetry();
  let reported = 0;
  for (const line of lines) {
    const diagnostic = parse(line);
    if (!diagnostic) continue;
    telemetry.startSpan('ios.diagnostic', { attributes: diagnosticAttributes(diagnostic) }).end();
    reported += 1;
  }
  // These describe a process that is already gone and were spooled on disk to survive exactly
  // this. Getting them off the device now means a second crash does not bury the first.
  if (reported > 0) await telemetry.flush();
  return reported;
}
