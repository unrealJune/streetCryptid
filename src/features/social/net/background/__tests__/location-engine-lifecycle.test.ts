/**
 * Whether the engine is running, and what a capture that arrives when it is not can tell you.
 *
 * The publish loop itself lives in Rust now (`gate.rs`, `outbox.rs`, `publish.rs`); what is left on
 * this side is the sampling policy, the state the settings screen renders, and this on/off flag.
 * The flag is small and it is load-bearing in the worst way: it sits in front of the native
 * pipeline, and an engine left `idle` while Core Location is still armed swallows every fix in
 * complete silence. On 2026-09-01 an iPhone did exactly that — 102 consecutive captures refused
 * over two hours, `sharing.enabled=true`, permissions granted, `location.running=true`, and no
 * other attribute anywhere that said why.
 *
 * These pin the part that made it diagnosable: a refusal names the state it refused in, because
 * `idle` and `error` are different bugs. `error` has an `engine.failed` span saying what threw;
 * `idle` has nothing at all and means a lifecycle race left the engine stopped but wired up.
 */

import {
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';
import { createTelemetry } from '@/features/dev/telemetry/telemetry';

import { createLocationEngine, type DrainOutcome, type NativeDrain } from '../location-engine';
import { createSamplingPolicy } from '../sampling-policy';

const fix = { lat: 47.6, lon: -122.3, accuracyM: 10, headingDeg: 0, ts: 1_000 };

const outcome = (over: Partial<DrainOutcome> = {}): DrainOutcome => ({
  accepted: true,
  rejection: null,
  enqueued: 1,
  published: 1,
  pending: 0,
  suspended: false,
  ...over,
});

function drainStub(): NativeDrain & { calls: number; fail: boolean } {
  const stub = {
    calls: 0,
    fail: false,
    async ingest(): Promise<DrainOutcome> {
      stub.calls += 1;
      if (stub.fail) throw new Error('native drain refused');
      return outcome();
    },
    async heartbeat(): Promise<DrainOutcome> {
      return outcome({ enqueued: 0, published: 0 });
    },
  };
  return stub;
}

function engineWith(drain: NativeDrain) {
  return createLocationEngine({ drain, policy: createSamplingPolicy() });
}

/** The `engine.ingest` refusals recorded since the last reset. */
function refusals(): Record<string, unknown>[] {
  return getEventLog()
    .filter((e) => e.action === 'engine.ingest')
    .map((e) => (e.details as { attributes: Record<string, unknown> })?.attributes ?? {});
}

describe('LocationEngine — the running flag in front of the native pipeline', () => {
  beforeEach(() => {
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({ now: () => 1_000 }));
  });

  afterEach(() => setTelemetryForTesting(undefined));

  it('refuses a capture before it has been started, and says it was idle', async () => {
    // The state a lifecycle race leaves behind: wired up, never started, silently eating fixes.
    const drain = drainStub();
    const engine = engineWith(drain);

    await engine.ingest(fix);

    expect(drain.calls).toBe(0);
    expect(refusals()).toEqual([{ 'sc.drop_reason': 'engine-not-running', status: 'idle' }]);
  });

  it('hands the capture to the native pipeline once started', async () => {
    const drain = drainStub();
    const engine = engineWith(drain);
    await engine.start();

    await engine.ingest(fix);

    expect(drain.calls).toBe(1);
    expect(refusals()).toEqual([]);
  });

  it('refuses again after a stop, still as idle', async () => {
    // `teardownBackground` stops the engine before it detaches it. Anything that arrives in that
    // window must be dropped rather than published — a shutdown is a shutdown.
    const drain = drainStub();
    const engine = engineWith(drain);
    await engine.start();
    await engine.stop();

    await engine.ingest(fix);

    expect(drain.calls).toBe(0);
    expect(refusals().at(-1)).toMatchObject({ status: 'idle' });
  });

  it('reports a throw as a failure rather than swallowing it', async () => {
    const drain = drainStub();
    const engine = engineWith(drain);
    await engine.start();
    drain.fail = true;

    await engine.ingest(fix);

    const failure = getEventLog().find((e) => e.action === 'engine.failed');
    expect(failure).toBeDefined();
    expect(engine.getState().status).toBe('error');
  });

  it('keeps trying after a failure instead of latching', async () => {
    // Latching on `error` meant one transient throw — a relay blink, a subscription being rebound
    // — disabled publishing for the whole life of the process, because nothing set the status
    // back. On 2026-09-01 an iPhone produced twelve `engine.failed` spans in two minutes and then
    // refused every capture of an entire drive. The native side retries by design; so does this.
    const drain = drainStub();
    const engine = engineWith(drain);
    await engine.start();
    drain.fail = true;
    await engine.ingest(fix);
    expect(engine.getState().status).toBe('error');

    drain.fail = false;
    const before = drain.calls;
    await engine.ingest(fix);

    expect(drain.calls).toBe(before + 1);
    expect(engine.getState().status).toBe('running');
    expect(engine.getState().error).toBeNull();
  });

  it('says out loud when a heartbeat is refused, rather than returning a bare zero', async () => {
    // The heartbeat is the ONLY thing publishing on a phone that is not moving, so an engine that
    // silently refuses it produces a device that emits nothing and reads exactly like one whose
    // owner is sitting still.
    const engine = engineWith(drainStub());

    await expect(engine.heartbeat()).resolves.toBe(0);

    const refused = getEventLog().find((e) => e.action === 'engine.heartbeat');
    expect((refused?.details as { attributes: Record<string, unknown> })?.attributes).toMatchObject(
      {
        'sc.drop_reason': 'engine-not-running',
        status: 'idle',
      }
    );
  });
});
