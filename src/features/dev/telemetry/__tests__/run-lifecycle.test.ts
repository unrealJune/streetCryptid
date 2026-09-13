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

  // A resumed process is the SAME run. Reporting it as an ended one would turn every suspension
  // into a false crash report, which is precisely the noise this span exists to cut through.
  it('does not report itself when begun twice in one process', async () => {
    await beginTelemetryRun(() => 10_000);
    await beginTelemetryRun(() => 20_000);
    expect(runSpans()).toHaveLength(0);
  });
});
