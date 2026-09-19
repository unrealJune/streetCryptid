import { AppState } from 'react-native';

import { getEventLog, resetEventLogForTesting } from '../event-log';
import {
  beginTelemetryRun,
  noteTelemetryRunState,
  resetTelemetryRunForTesting,
} from '../run-lifecycle';
import { createTelemetry, setTelemetryForTesting } from '../telemetry';

// The durable half of the mechanism. SQLite is absent under jest, so the meta store is stubbed
// here — what is under test is the decision made from what it holds, not expo-sqlite. Everything
// else in the module (including the real `recordEventLog` the spans land in) stays genuine.
const mockMeta = new Map<string, string>();
const mockLastEntry = { value: null as number | null };
jest.mock('../event-log', () => ({
  ...jest.requireActual('../event-log'),
  readMeta: jest.fn(async (key: string) => mockMeta.get(key) ?? null),
  writeMeta: jest.fn(async (key: string, value: string) => void mockMeta.set(key, value)),
  lastEntryTimestamp: jest.fn(async () => mockLastEntry.value),
}));

function runSpans(): ReturnType<typeof getEventLog> {
  return getEventLog().filter((entry) => entry.action === 'app.previous_run');
}

function lifecycleSpans(): ReturnType<typeof getEventLog> {
  return getEventLog().filter((entry) => entry.action === 'app.lifecycle');
}

describe('telemetry run lifecycle', () => {
  beforeEach(() => {
    mockMeta.clear();
    mockLastEntry.value = null;
    resetEventLogForTesting();
    resetTelemetryRunForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 10_000 }));
    (AppState as unknown as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    resetTelemetryRunForTesting();
    setTelemetryForTesting(undefined);
  });

  it('says nothing about a previous run on a first-ever launch', async () => {
    await beginTelemetryRun(() => 10_000);
    expect(runSpans()).toHaveLength(0);
    expect(mockMeta.get('run.foreground')).toBeDefined();
  });

  // The case that matters: the app disappeared while someone was looking at it. That is a crash,
  // a watchdog kill or a jetsam — never routine.
  it('reports a previous run that ended in the foreground, and how long it was dark', async () => {
    mockMeta.set(
      'run.foreground',
      JSON.stringify({
        runId: 'oldrun',
        startedAt: 1_000,
        lastState: 'active',
        lastStateAt: 4_000,
      })
    );
    mockLastEntry.value = 4_500;

    await beginTelemetryRun(() => 10_000);

    const [span] = runSpans();
    expect(span).toBeDefined();
    expect(span.details).toMatchObject({
      attributes: expect.objectContaining({
        'prev.run_id': 'oldrun',
        'prev.last_state': 'active',
        'prev.ended_in_foreground': true,
        'prev.uptime_ms': 3_000,
        'prev.dark_ms': 5_500,
      }),
    });
  });

  // iOS reclaiming a backgrounded app is not a bug, and must be filterable from the above rather
  // than indistinguishable from it.
  it('marks a previous run that ended in the background as not a foreground death', async () => {
    mockMeta.set(
      'run.foreground',
      JSON.stringify({
        runId: 'oldrun',
        startedAt: 1_000,
        lastState: 'background',
        lastStateAt: 4_000,
      })
    );

    await beginTelemetryRun(() => 10_000);

    const [span] = runSpans();
    expect(span.details).toMatchObject({
      attributes: expect.objectContaining({
        'prev.last_state': 'background',
        'prev.ended_in_foreground': false,
        // No journal rows at all: reported as unknown rather than as zero darkness.
        'prev.dark_ms': -1,
      }),
    });
  });

  it('records the state the run is in, so the next run can report it', async () => {
    await beginTelemetryRun(() => 10_000);
    await noteTelemetryRunState('background', () => 12_000);

    const stored = JSON.parse(mockMeta.get('run.foreground') as string) as Record<string, unknown>;
    expect(stored.lastState).toBe('background');
    expect(stored.lastStateAt).toBe(12_000);
  });

  // The gap this closes: on 2026-09-13 a phone was sent to the home screen in the middle of a
  // pairing and NOTHING recorded it. The fact had to be inferred from unrelated console noise.
  it('records leaving the foreground, with how long the run had been in it', async () => {
    await beginTelemetryRun(() => 10_000);
    await noteTelemetryRunState('background', () => 12_500);

    const [span] = lifecycleSpans();
    expect(span).toBeDefined();
    expect(span.details).toMatchObject({
      attributes: expect.objectContaining({
        'app.from': 'active',
        'app.to': 'background',
        'app.state_ms': 2_500,
        'app.left_foreground': true,
      }),
    });
  });

  it('records coming back, and does not call that leaving the foreground', async () => {
    await beginTelemetryRun(() => 10_000);
    await noteTelemetryRunState('background', () => 12_000);
    await noteTelemetryRunState('active', () => 30_000);

    // Newest first.
    const [span] = lifecycleSpans();
    expect(span.details).toMatchObject({
      attributes: expect.objectContaining({
        'app.from': 'background',
        'app.to': 'active',
        'app.state_ms': 18_000,
        'app.left_foreground': false,
      }),
    });
  });

  // iOS reports `inactive` on the way through (control centre, the app switcher, a call banner)
  // and settles back to `active`. Recording the repeat would be noise with no transition in it.
  it('says nothing when the state has not actually changed', async () => {
    await beginTelemetryRun(() => 10_000);
    await noteTelemetryRunState('active', () => 11_000);
    expect(lifecycleSpans()).toHaveLength(0);
  });

  // A span describing the moment the OS may stop running us is worthless if it is still sitting
  // in an unexported batch when it does.
  it('flushes on the way out, after the durable record is correct', async () => {
    const flush = jest.fn(async () => undefined);
    const telemetry = createTelemetry({ now: () => 10_000 });
    setTelemetryForTesting({ ...telemetry, flush });

    await beginTelemetryRun(() => 10_000);
    await noteTelemetryRunState('background', () => 12_000);
    expect(flush).toHaveBeenCalledTimes(1);

    flush.mockClear();
    await noteTelemetryRunState('active', () => 13_000);
    expect(flush).not.toHaveBeenCalled();
  });

  // A resumed process is the SAME run. Reporting it as an ended one would turn every suspension
  // into a false crash report, which is precisely the noise this span exists to cut through.
  it('does not report itself when begun twice in one process', async () => {
    await beginTelemetryRun(() => 10_000);
    await beginTelemetryRun(() => 20_000);
    expect(runSpans()).toHaveLength(0);
  });

  /**
   * A BACKGROUND launch is not a foreground run.
   *
   * `_layout.tsx` calls `beginTelemetryRun` at module scope, and iOS reaches module scope on a
   * background launch too — which is the `app.previous_run` recorded at 00:36 on 2026-09-18 from a
   * launch nobody was looking at. Claiming there overwrites the record the real foreground run
   * left with `lastState: 'background'`, so the NEXT launch reports the wrong ending for it: a
   * crash that happened while someone was watching reads as routine OS reclamation.
   */
  describe('a launch into the background', () => {
    /** Replace `addEventListener` so a state transition can actually be delivered. */
    function appStateHarness() {
      const listeners: ((state: string) => void)[] = [];
      const original = AppState.addEventListener;
      (AppState as unknown as { addEventListener: unknown }).addEventListener = (
        _event: string,
        listener: (state: string) => void
      ) => {
        listeners.push(listener);
        return {
          remove: () => {
            const at = listeners.indexOf(listener);
            if (at >= 0) listeners.splice(at, 1);
          },
        };
      };
      return {
        listenerCount: () => listeners.length,
        go(state: string) {
          (AppState as unknown as { currentState: string }).currentState = state;
          for (const listener of [...listeners]) listener(state);
        },
        restore: () => {
          (AppState as unknown as { addEventListener: unknown }).addEventListener = original;
        },
      };
    }

    let harness: ReturnType<typeof appStateHarness>;

    beforeEach(() => {
      harness = appStateHarness();
      (AppState as unknown as { currentState: string }).currentState = 'background';
    });
    afterEach(() => harness.restore());

    it('claims nothing and reports nothing', async () => {
      mockMeta.set(
        'run.foreground',
        JSON.stringify({
          runId: 'oldrun',
          startedAt: 1_000,
          lastState: 'active',
          lastStateAt: 4_000,
        })
      );

      await beginTelemetryRun(() => 10_000);

      expect(runSpans()).toHaveLength(0);
      // The previous run's record is untouched — still `active`, still reportable.
      expect(JSON.parse(mockMeta.get('run.foreground') as string)).toMatchObject({
        runId: 'oldrun',
        lastState: 'active',
      });
    });

    it('claims the run on the first foreground, and reports the previous one then', async () => {
      mockMeta.set(
        'run.foreground',
        JSON.stringify({
          runId: 'oldrun',
          startedAt: 1_000,
          lastState: 'active',
          lastStateAt: 4_000,
        })
      );
      mockLastEntry.value = 4_500;

      await beginTelemetryRun(() => 10_000);
      expect(runSpans()).toHaveLength(0);

      harness.go('active');
      // The deferred claim re-enters `beginTelemetryRun`, which awaits the meta store three times
      // over; drain the microtask queue rather than counting ticks.
      await new Promise((resolve) => setImmediate(resolve));

      expect(runSpans()).toHaveLength(1);
      expect(runSpans()[0].details).toMatchObject({
        attributes: expect.objectContaining({ 'prev.ended_in_foreground': true }),
      });
    });

    /**
     * The deferral must not itself leak. A background launch that is woken repeatedly would
     * otherwise stack one listener per call for the life of the process.
     */
    it('waits with exactly one listener however many times it is called', async () => {
      await beginTelemetryRun(() => 10_000);
      await beginTelemetryRun(() => 11_000);
      await beginTelemetryRun(() => 12_000);
      expect(harness.listenerCount()).toBe(1);
    });

    /**
     * `'inactive'` is NOT background. iOS reports it during a cold foreground launch and while a
     * permission alert is up, so deferring on it would defer every normal launch — the lesson
     * `native-runtime-owner.ts` records about trusting `AppState.currentState` as a guard.
     */
    it('treats an inactive launch as a foreground one', async () => {
      (AppState as unknown as { currentState: string }).currentState = 'inactive';
      await beginTelemetryRun(() => 10_000);
      expect(mockMeta.get('run.foreground')).toBeDefined();
    });
  });
});
