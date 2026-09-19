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
/** The one-shot listener waiting for a foreground, when the app was launched into the background. */
let deferred: { remove(): void } | null = null;

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

  // A BACKGROUND launch is not a foreground run, and claiming one here is how the docstring above
  // stopped being true. `_layout.tsx` calls this at module scope, which iOS reaches on a background
  // launch too — that is the `app.previous_run` in the 2026-09-18 timeline, emitted at 00:36 from a
  // launch nobody was looking at. Claiming there writes `lastState: 'background'` over the record
  // the real foreground run left, so the next launch reports the wrong ending for the wrong run.
  //
  // Wait for a foreground instead. Exactly `'background'`: iOS reports `'inactive'` during a cold
  // foreground launch and while a permission alert is up, and treating that as background would
  // defer every normal launch — the lesson `native-runtime-owner.ts` records about using
  // `AppState.currentState` as a guard at all.
  if (AppState.currentState === 'background') {
    if (deferred) return;
    deferred = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      deferred?.remove();
      deferred = null;
      void beginTelemetryRun(now);
    });
    return;
  }

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
 * stopped — and emit the transition, so THIS run can say it too.
 *
 * ## Why the transition is a span and not only a stored field
 * `app.previous_run` answers "how did the last run end", which is a question you can only ask
 * after the fact and only once per launch. It says nothing about a run that is still going, and
 * "still going" is the state the app is in for every interesting question about it.
 *
 * On 2026-09-13 a pairing failed three times in ninety seconds, and the single most load-bearing
 * fact — that one of the two phones had been sent to the home screen partway through — was not
 * recorded anywhere. It had to be inferred from a burst of Skia deprecation warnings that happen
 * to fire when the map screen remounts, which is not evidence, it is a coincidence that held.
 * Backgrounding is a first-class event in the life of this app: it suspends the JS context, drops
 * the transport's paths, and ends handshakes. It should not take a forensic reading of unrelated
 * console noise to see one.
 *
 * The flush is the other half. A span recorded on the way to the background is describing the
 * exact moment the OS may stop running us, so it is persisted and drained before we return rather
 * than left in a batch that a suspended process will never export.
 */
export async function noteTelemetryRunState(
  state: AppStateStatus,
  now: () => number = Date.now
): Promise<void> {
  const run = current;
  if (!run) return;
  const at = now();
  const from = run.lastState;
  if (state !== from) {
    getTelemetry()
      .startSpan('app.lifecycle', {
        attributes: {
          'app.from': from,
          'app.to': state,
          // How long it held the state it is leaving. A foreground stretch of two seconds is a
          // user bouncing off something; two minutes is a user doing something.
          'app.state_ms': Math.max(0, at - run.lastStateAt),
          'app.run_ms': Math.max(0, at - run.startedAt),
          // The transition worth filtering on: everything the app was in the middle of stops here.
          'app.left_foreground': from === 'active' && state !== 'active',
        },
      })
      .end();
  }
  await persist({ ...run, lastState: state, lastStateAt: at });
  // Ordered after the persist so the durable record is already correct if the flush is the last
  // thing this process ever does.
  if (from === 'active' && state !== 'active') {
    await getTelemetry()
      .flush()
      .catch(() => undefined);
  }
}

/** Test seam: forget the in-memory claim and stop listening. */
export function resetTelemetryRunForTesting(): void {
  subscription?.remove();
  subscription = null;
  deferred?.remove();
  deferred = null;
  current = null;
}
