import { AppState, type AppStateStatus } from 'react-native';

import { lastEntryTimestamp, readMeta, writeMeta } from './event-log';
import { getRunId } from './resource';
import { getTelemetry } from './telemetry';

/**
 * What happened to the LAST run of the app, reported by the next one.
 *
 * ## The hole this fills
 * A phone that stops recording leaves a gap, and a gap is the same shape whatever caused it. On
 * 2026-09-13 an iPhone's last span was at 21:53:43, the next at 21:55:05, and nothing in the data
 * could distinguish the three possibilities: the process crashed and iOS relaunched it, the user
 * force-quit it, or iOS simply suspended it and woke it again. Those want completely different
 * fixes, and the telemetry was silent on which one to chase.
 *
 * The trick is that only one of them starts a new JavaScript context. So a run that records its
 * own existence durably, and a next run that finds that record still open, together say "the
 * process went away" — while a suspension says nothing at all, because the same context resumes
 * and the record is still its own.
 *
 * ## What it can and cannot tell you
 * `prev.last_state` is the honest discriminator. A run that vanished while `active` was killed
 * out from under a user who was looking at it: a crash, a watchdog kill, or a jetsam. A run that
 * vanished while `background` was almost certainly just reclaimed by iOS, which is routine and
 * not worth chasing.
 *
 * It does NOT separate a crash from a force-quit. Nothing in-process can: both end the runtime
 * without warning, and the app is not told in either case. That distinction lives in the OS —
 * MetricKit's diagnostic payloads, or the `.ips` under Analytics Data — and is the reason this
 * span reports a state rather than a verdict.
 */

/** The durable record of the currently-running foreground context. */
const RUN_KEY = 'run.foreground';

interface OpenRun {
  readonly runId: string;
  readonly startedAt: number;
  readonly lastState: AppStateStatus;
  readonly lastStateAt: number;
}

function parseOpenRun(raw: string | null): OpenRun | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OpenRun>;
    if (typeof value.runId !== 'string' || typeof value.startedAt !== 'number') return null;
    return {
      runId: value.runId,
      startedAt: value.startedAt,
      lastState: (value.lastState ?? 'unknown') as AppStateStatus,
      lastStateAt: typeof value.lastStateAt === 'number' ? value.lastStateAt : value.startedAt,
    };
  } catch {
    return null;
  }
}

let current: OpenRun | null = null;
let subscription: { remove(): void } | null = null;

async function persist(run: OpenRun): Promise<void> {
  current = run;
  await writeMeta(RUN_KEY, JSON.stringify(run));
}

/**
 * Claim this context as the foreground run, and report on the one before it.
 *
 * Call once, from the app shell. Deliberately NOT called by headless background contexts: the OS
 * ends those without ceremony every single time, so an "ended without warning" record for one
 * would be noise with a 100% false-positive rate — and it would clobber the foreground record
 * they share a database with.
 */
export async function beginTelemetryRun(now: () => number = Date.now): Promise<void> {
  const runId = getRunId();
  if (current?.runId === runId) return;

  const previous = parseOpenRun(await readMeta(RUN_KEY));
  const startedAt = now();
  await persist({
    runId,
    startedAt,
    lastState: AppState.currentState,
    lastStateAt: startedAt,
  });

  if (previous && previous.runId !== runId) {
    // `lastEntryTimestamp` is read AFTER our own record is persisted but describes rows written
    // before this process existed — the journal is append-only and we have recorded nothing yet.
    const lastRecord = await lastEntryTimestamp();
    getTelemetry()
      .startSpan('app.previous_run', {
        attributes: {
          'prev.run_id': previous.runId,
          'prev.last_state': previous.lastState,
          // How long it ran, and how long it had been in that state when it stopped.
          'prev.uptime_ms': Math.max(0, previous.lastStateAt - previous.startedAt),
          'prev.state_age_ms': Math.max(0, startedAt - previous.lastStateAt),
          // The size of the hole: last thing it ever recorded, to now.
          'prev.dark_ms': lastRecord === null ? -1 : Math.max(0, startedAt - lastRecord),
          // The part worth alerting on. A run that disappeared while someone was looking at it is
          // a crash, a watchdog kill or a jetsam; one that disappeared in the background is iOS
          // doing its job.
          'prev.ended_in_foreground': previous.lastState === 'active',
        },
      })
      .end();
  }

  subscription?.remove();
  subscription = AppState.addEventListener('change', (state) => {
    void noteTelemetryRunState(state, now);
  });
}

/**
 * Record the app state this run is now in, so the next run can say what it was doing when it
 * stopped. Cheap and rare — AppState changes a handful of times per session.
 */
export async function noteTelemetryRunState(
  state: AppStateStatus,
  now: () => number = Date.now
): Promise<void> {
  const run = current;
  if (!run) return;
  await persist({ ...run, lastState: state, lastStateAt: now() });
}

/** Test seam: forget the in-memory claim and stop listening. */
export function resetTelemetryRunForTesting(): void {
  subscription?.remove();
  subscription = null;
  current = null;
}
