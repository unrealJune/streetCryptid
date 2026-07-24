import type { LocationFix } from '../../../core/types';
import type { FixOutbox } from '../fix-outbox';
import { createLocationEngine, type EngineState, type FixPublisher } from '../location-engine';
import { createSamplingPolicy } from '../sampling-policy';
import { createTrailStore, InMemoryTrailStorage, SELF_AUTHOR } from '../trail-store';
import type { BatteryState } from '../types';

function fix(ts: number, overrides: Partial<LocationFix> = {}): LocationFix {
  return { lat: 40, lon: -73, accuracyM: 5, headingDeg: 0, ts, ...overrides };
}

/** Inline in-memory FixOutbox — decoupled from the real createFixOutbox. */
function fakeOutbox(): FixOutbox {
  const items: LocationFix[] = [];
  return {
    async enqueue(f: LocationFix): Promise<void> {
      items.push(f);
    },
    async drain(publish: (f: LocationFix) => Promise<void>): Promise<number> {
      let n = 0;
      while (items.length > 0) {
        try {
          await publish(items[0]);
        } catch {
          break;
        }
        items.shift();
        n += 1;
      }
      return n;
    },
    async pending(): Promise<number> {
      return items.length;
    },
    async clear(): Promise<void> {
      items.length = 0;
    },
  };
}

function fakePublisher(): FixPublisher & { setReady: (r: boolean) => void; seqs: number[] } {
  let ready = false;
  let seq = 0;
  const seqs: number[] = [];
  return {
    async publishFix(): Promise<number> {
      seq += 1;
      seqs.push(seq);
      return seq;
    },
    isReady(): boolean {
      return ready;
    },
    setReady(r: boolean): void {
      ready = r;
    },
    seqs,
  };
}

function fullBattery(): () => Promise<BatteryState> {
  return async () => ({ level: 1, charging: false, lowPower: false });
}

describe('location engine', () => {
  it('holds fixes pending when publisher not ready, then publishes in order on flush', async () => {
    const publisher = fakePublisher();
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage(), now: () => 1000 });
    let t = 0;
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: fullBattery(),
      now: () => t,
    });
    await engine.start();

    t = 0;
    await engine.ingest(fix(0));
    t = 20_000;
    await engine.ingest(fix(20_000, { lat: 41 }));

    expect(await outbox.pending()).toBe(2);
    expect(await trail.rangeFor(SELF_AUTHOR, 0)).toHaveLength(0);
    expect(engine.getState().pending).toBe(2);

    publisher.setReady(true);
    const n = await engine.flush();
    expect(n).toBe(2);
    expect(await outbox.pending()).toBe(0);

    const points = await trail.rangeFor(SELF_AUTHOR, 0);
    expect(points.map((p) => p.seq)).toEqual([1, 2]);
    expect(publisher.seqs).toEqual([1, 2]);
    expect(engine.getState().pending).toBe(0);
  });

  it('auto-flushes on ingest when publisher is ready', async () => {
    const publisher = fakePublisher();
    publisher.setReady(true);
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    let t = 0;
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: fullBattery(),
      now: () => t,
    });
    await engine.start();

    await engine.ingest(fix(0));
    expect(await outbox.pending()).toBe(0);
    expect(await trail.rangeFor(SELF_AUTHOR, 0)).toHaveLength(1);
    expect(engine.getState().pending).toBe(0);
  });

  it('does not enqueue when decision.active is false', async () => {
    const publisher = fakePublisher();
    publisher.setReady(true);
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    let t = 0;
    // suspendBelowLevel high + stationary + low battery not charging ⇒ active false
    const policy = createSamplingPolicy({ suspendBelowLevel: 0.5 });
    const battery: () => Promise<BatteryState> = async () => ({
      level: 0.1,
      charging: false,
      lowPower: false,
    });
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy,
      battery,
      now: () => t,
    });
    await engine.start();

    // first fix → motion 'unknown' (may be active); second at same spot → stationary
    t = 0;
    await engine.ingest(fix(0));
    outbox.clear();

    t = 30_000;
    const decision = await engine.ingest(fix(30_000)); // same lat/lon ⇒ stationary
    expect(decision.active).toBe(false);
    expect(await outbox.pending()).toBe(0);
  });

  it('onState listener fires immediately and on changes', async () => {
    const publisher = fakePublisher();
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: fullBattery(),
      now: () => 0,
    });

    const seen: EngineState[] = [];
    const unsub = engine.onState((s) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('idle');

    await engine.start();
    expect(seen[seen.length - 1].status).toBe('running');

    unsub();
    await engine.stop();
    expect(seen[seen.length - 1].status).toBe('running'); // no more updates after unsub
  });

  it('tracks motion class in state and re-reads battery on reevaluate()', async () => {
    const publisher = fakePublisher();
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    let batt: BatteryState = { level: 1, charging: false, lowPower: false };
    let t = 0;
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: async () => batt,
      now: () => t,
    });
    await engine.start();

    t = 0;
    await engine.ingest(fix(0));
    t = 20_000;
    await engine.ingest(fix(20_000)); // same spot ⇒ stationary
    expect(engine.getState().motion).toBe('stationary');
    // stationary, full battery: base 45s × stationaryMultiplier 4 = 180s.
    expect(engine.getState().decision?.timeIntervalMs).toBe(180_000);

    // Low Power Mode toggles on with no new fix — reevaluate must pick it up from a fresh read.
    batt = { level: 1, charging: false, lowPower: true };
    const decision = await engine.reevaluate();
    expect(engine.getState().motion).toBe('stationary'); // motion unchanged
    // stationary 180s × lowBatteryMultiplier 3 = 540s, clamped to maxIntervalMs 300s.
    expect(decision.timeIntervalMs).toBe(300_000);
    // Stationary already chose `low`; the low-battery clamp coarsens but must never re-tighten it.
    expect(decision.accuracy).toBe('low');
  });

  it('live mode overrides cadence and reverts when turned off', async () => {
    const publisher = fakePublisher();
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    let t = 0;
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: fullBattery(),
      now: () => t,
    });
    await engine.start();

    t = 0;
    await engine.ingest(fix(0));
    t = 20_000;
    await engine.ingest(fix(20_000)); // stationary → 180s ambient cadence
    expect(engine.getState().decision?.timeIntervalMs).toBe(180_000);

    const live = await engine.setLiveMode(true);
    expect(live.timeIntervalMs).toBe(4_000); // real-time, ignores stationary
    expect(live.accuracy).toBe('high');

    const reverted = await engine.setLiveMode(false);
    expect(reverted.timeIntervalMs).toBe(180_000); // back to ambient for the same motion
  });

  it('stop() prevents enqueue but still records the fix', async () => {
    const publisher = fakePublisher();
    publisher.setReady(true);
    const outbox = fakeOutbox();
    const trail = createTrailStore({ storage: new InMemoryTrailStorage() });
    let t = 0;
    const engine = createLocationEngine({
      publisher,
      outbox,
      trail,
      policy: createSamplingPolicy(),
      battery: fullBattery(),
      now: () => t,
    });
    // never started (idle)
    t = 100;
    const decision = await engine.ingest(fix(100));
    expect(decision).toBeTruthy();
    expect(await outbox.pending()).toBe(0);
    expect(engine.getState().lastFixAt).toBe(100);
    expect(engine.getState().decision).not.toBeNull();
  });
});
