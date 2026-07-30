import type { LocationFix } from '../../../core/types';
import { DEFAULT_FIX_QUALITY_CONFIG } from '../fix-quality';
import type { FixOutbox } from '../fix-outbox';
import {
  createLocationEngine,
  MAX_BACKFILL_MS,
  type EngineState,
  type FixPublisher,
} from '../location-engine';
import { createSamplingPolicy } from '../sampling-policy';
import { createTrailStore, InMemoryTrailStorage, SELF_AUTHOR } from '../trail-store';
import type { BatteryState } from '../types';

/** The default cadence, and therefore the width of one publish slot in these tests. */
const SLOT = 300_000;

const BASE_LAT = 40;
const M_PER_DEG_LAT = 6_371_000 * (Math.PI / 180);

function fix(ts: number, overrides: Partial<LocationFix> = {}): LocationFix {
  return { lat: BASE_LAT, lon: -73, accuracyM: 5, headingDeg: 0, ts, ...overrides };
}

/** Latitude `metres` north of the base — coordinates have to be plausible now that the gate runs. */
function latNorth(metres: number): number {
  return BASE_LAT + metres / M_PER_DEG_LAT;
}

/** A fix `metres` north of the base at `ts`. */
function north(ts: number, metres: number): LocationFix {
  return fix(ts, { lat: latNorth(metres) });
}

/** Inline in-memory FixOutbox — decoupled from the real createFixOutbox. */
function fakeOutbox(): FixOutbox & { items: LocationFix[] } {
  const items: LocationFix[] = [];
  return {
    items,
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

function fakePublisher(): FixPublisher & {
  setReady: (r: boolean) => void;
  published: LocationFix[];
  seqs: number[];
  pushes: number;
  log: string[];
} {
  let ready = false;
  let seq = 0;
  const seqs: number[] = [];
  const log: string[] = [];
  const published: LocationFix[] = [];
  const self = {
    async publishFix(f: LocationFix): Promise<number> {
      seq += 1;
      seqs.push(seq);
      published.push(f);
      log.push(`publish:${seq}`);
      return seq;
    },
    async pushTrail(): Promise<void> {
      self.pushes += 1;
      log.push('push');
    },
    isReady(): boolean {
      return ready;
    },
    setReady(r: boolean): void {
      ready = r;
    },
    published,
    seqs,
    pushes: 0,
    log,
  };
  return self;
}

function fullBattery(): () => Promise<BatteryState> {
  return async () => ({ level: 1, charging: false, lowPower: false });
}

/** Assemble an engine over fakes with a controllable clock. */
function harness(
  opts: {
    ready?: boolean;
    battery?: () => Promise<BatteryState>;
    policy?: ReturnType<typeof createSamplingPolicy>;
  } = {}
) {
  const publisher = fakePublisher();
  publisher.setReady(opts.ready ?? false);
  const outbox = fakeOutbox();
  const trail = createTrailStore({ storage: new InMemoryTrailStorage(), now: () => 1000 });
  const clock = { t: 0 };
  const engine = createLocationEngine({
    publisher,
    outbox,
    trail,
    policy: opts.policy ?? createSamplingPolicy(),
    battery: opts.battery ?? fullBattery(),
    now: () => clock.t,
  });
  return { publisher, outbox, trail, clock, engine };
}

describe('location engine', () => {
  it('holds fixes pending when publisher not ready, then publishes in order on flush', async () => {
    const { publisher, outbox, trail, clock, engine } = harness();
    await engine.start();

    clock.t = 0;
    await engine.ingest(fix(0));
    clock.t = SLOT;
    await engine.ingest(fix(SLOT, { lat: 41 }));

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

  // publishFix writes the LOCAL docs replica; only pushTrail gets the batch to the stash, and
  // without it an offline friend has nothing to reconcile from.
  it('pushes the durable trail once per flush, after every fix in the batch is published', async () => {
    const { publisher, clock, engine } = harness();
    await engine.start();

    await engine.ingest(fix(0));
    clock.t = SLOT;
    await engine.ingest(fix(SLOT, { lat: 41 }));

    publisher.setReady(true);
    await engine.flush();

    expect(publisher.log).toEqual(['publish:1', 'publish:2', 'push']);
    expect(publisher.pushes).toBe(1);
  });

  it('does not push when the flush published nothing', async () => {
    const { publisher, engine } = harness({ ready: true });
    await engine.start();

    await engine.flush();

    expect(publisher.pushes).toBe(0);
  });

  it('auto-flushes on ingest when publisher is ready', async () => {
    const { outbox, trail, engine } = harness({ ready: true });
    await engine.start();

    await engine.ingest(fix(0));
    expect(await outbox.pending()).toBe(0);
    expect(await trail.rangeFor(SELF_AUTHOR, 0)).toHaveLength(1);
    expect(engine.getState().pending).toBe(0);
  });

  it('does not enqueue when decision.active is false', async () => {
    const { outbox, engine } = harness({
      ready: true,
      policy: createSamplingPolicy({ suspendBelowLevel: 0.5 }),
      battery: async () => ({ level: 0.1, charging: false, lowPower: false }),
    });
    await engine.start();

    const decision = await engine.ingest(fix(0));
    expect(decision.active).toBe(false);
    expect(await outbox.pending()).toBe(0);
  });

  it('onState listener fires immediately and on changes', async () => {
    const { engine } = harness();

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

  it('re-reads battery on reevaluate() without a new fix', async () => {
    let batt: BatteryState = { level: 1, charging: false, lowPower: false };
    const { clock, engine } = harness({
      battery: async () => batt,
      // Distinct tiers so the re-read is observable; the shipped defaults use one tier throughout.
      policy: createSamplingPolicy({ normalAccuracy: 'balanced', lowBatteryAccuracy: 'low' }),
    });
    await engine.start();

    clock.t = 0;
    await engine.ingest(fix(0));
    expect(engine.getState().decision?.accuracy).toBe('balanced');

    // Low Power Mode toggles on with no new fix — reevaluate must pick it up from a fresh read.
    batt = { level: 1, charging: false, lowPower: true };
    const decision = await engine.reevaluate();
    expect(decision.accuracy).toBe('low');
    // ...and the cadence must be untouched by it.
    expect(decision.timeIntervalMs).toBe(SLOT);
  });

  it('live mode overrides cadence and reverts when turned off', async () => {
    const { clock, engine } = harness();
    await engine.start();

    clock.t = 0;
    await engine.ingest(fix(0));
    expect(engine.getState().decision?.timeIntervalMs).toBe(SLOT);

    const live = await engine.setLiveMode(true);
    expect(live.timeIntervalMs).toBe(4_000);
    expect(live.accuracy).toBe('high');

    const reverted = await engine.setLiveMode(false);
    expect(reverted.timeIntervalMs).toBe(SLOT);
  });

  it('stop() prevents enqueue but still records the fix', async () => {
    const { outbox, clock, engine } = harness({ ready: true });
    // never started (idle)
    clock.t = 100;
    const decision = await engine.ingest(fix(100));
    expect(decision).toBeTruthy();
    expect(await outbox.pending()).toBe(0);
    expect(engine.getState().lastFixAt).toBe(100);
    expect(engine.getState().decision).not.toBeNull();
  });

  // The cadence is the privacy boundary: an observer of the encrypted stream must not be able to
  // tell a walk from a drive from sitting still. These cover that it holds whatever the OS does.
  describe('slot quantisation', () => {
    it('publishes once per slot however many fixes arrive in it', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      // A burst, as the foreground watch would deliver while walking.
      for (const offset of [0, 1_000, 30_000, 120_000, 299_000]) {
        clock.t = offset;
        await engine.ingest(fix(offset, { lat: 40 + offset / 1e6 }));
      }

      expect(publisher.published).toHaveLength(1);
    });

    it('absorbs further fixes in an already-published slot until the next boundary', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      clock.t = 10_000;
      await engine.ingest(north(10_000, 20));
      clock.t = SLOT;
      await engine.ingest(north(SLOT, 40));

      // The middle fix never goes out on its own; slot 1 carries the latest position instead.
      expect(publisher.published.map((f) => f.lat)).toEqual([BASE_LAT, latNorth(40)]);
    });

    it('emits one envelope per slot at a steady rate regardless of fix rate', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      // Slot 0: a flood. Slots 1-2: nothing but the heartbeat. Slot 3: one fix.
      clock.t = 0;
      for (let i = 0; i < 20; i += 1) {
        clock.t = i * 1_000;
        await engine.ingest(fix(clock.t));
      }
      clock.t = SLOT;
      await engine.heartbeat();
      clock.t = 2 * SLOT;
      await engine.heartbeat();
      clock.t = 3 * SLOT;
      await engine.ingest(fix(clock.t));

      expect(publisher.published).toHaveLength(4);
    });

    it('publishes the current slot immediately on the first fix', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      // Mid-slot start: a user who just enabled sharing should not wait for the next boundary.
      clock.t = SLOT * 7 + 123_456;
      await engine.ingest(fix(clock.t));

      expect(publisher.published).toHaveLength(1);
    });
  });

  // Android's fused provider periodically reports a position kilometres away. The gate keeps it out
  // of the trail — without letting its absence become a signal in itself.
  describe('confidence gate', () => {
    /** A fix coarse enough to fail the accuracy test. */
    const junk = (ts: number): LocationFix => fix(ts, { accuracyM: 3_000 });

    it('does not publish a junk fix', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      clock.t = SLOT;
      await engine.ingest(junk(SLOT));

      expect(publisher.published.map((f) => f.accuracyM)).toEqual([5, 5]);
    });

    // THE property. If a rejected fix silenced its slot, then "no envelope" would mean "bad GPS"
    // — indoors, a basement, the Underground — which is the same class of inference the fixed
    // cadence exists to prevent.
    it('keeps the cadence exactly as if the fix had been good', async () => {
      const good = harness({ ready: true });
      const bad = harness({ ready: true });
      await good.engine.start();
      await bad.engine.start();

      for (const slot of [0, 1, 2, 3]) {
        good.clock.t = slot * SLOT;
        bad.clock.t = slot * SLOT;
        await good.engine.ingest(north(slot * SLOT, slot * 50));
        await bad.engine.ingest(slot === 0 ? fix(0) : junk(slot * SLOT));
      }

      expect(bad.publisher.published).toHaveLength(good.publisher.published.length);
    });

    it('republishes the last good position while GPS is bad', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      clock.t = SLOT;
      await engine.ingest(junk(SLOT));

      expect(publisher.published[1]).toEqual(fix(0));
    });

    it('holds the local dot at the last accepted position', async () => {
      const { clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      const original = fix(0);
      await engine.ingest(original);
      clock.t = SLOT;
      await engine.ingest(junk(SLOT));

      // What the map's own-position marker follows — a rejected fix must not throw it across town.
      expect(engine.getState().lastAcceptedFix).toEqual(original);
      expect(engine.getState().lastRejection).toBe('inaccurate');
    });

    it('publishes nothing at all until a first fix passes', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(junk(0));
      clock.t = SLOT;
      await engine.heartbeat();

      // Nothing to republish yet: better absent than confidently wrong on the very first ping.
      expect(publisher.published).toHaveLength(0);
    });

    it('gives up being fussy once nothing has passed for long enough', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start(); // arms the escape hatch at t=0

      clock.t = 60_000;
      await engine.ingest(junk(clock.t));
      expect(publisher.published).toHaveLength(0);

      // A coarse position beats a trail that never starts.
      clock.t = DEFAULT_FIX_QUALITY_CONFIG.acceptAnythingAfterMs;
      await engine.ingest(junk(clock.t));
      expect(publisher.published).toHaveLength(1);
    });

    it('does not let junk through in live mode either', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();
      clock.t = 0;
      await engine.ingest(fix(0));
      await engine.setLiveMode(true);

      clock.t = 4_000;
      await engine.ingest(junk(4_000));

      expect(publisher.published).toHaveLength(1);
    });
  });

  describe('heartbeat', () => {
    it('republishes the last known fix verbatim when a slot produces nothing', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      const original = fix(0, { lat: 40, lon: -73 });
      await engine.ingest(original);

      clock.t = SLOT;
      const n = await engine.heartbeat();

      expect(n).toBe(1);
      // Timestamp untouched: the heartbeat keeps the cadence uniform without inventing freshness,
      // so friends still see this position as SLOT-milliseconds stale.
      expect(publisher.published[1]).toEqual(original);
    });

    it('is a no-op before the first fix', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = SLOT;
      expect(await engine.heartbeat()).toBe(0);
      expect(publisher.published).toHaveLength(0);
    });

    it('is a no-op when the current slot is already published', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      expect(await engine.heartbeat()).toBe(0);
      expect(publisher.published).toHaveLength(1);
    });

    it('is a no-op while suspended on a critical battery', async () => {
      const { publisher, clock, engine } = harness({
        ready: true,
        policy: createSamplingPolicy({ suspendBelowLevel: 0.5 }),
        battery: async () => ({ level: 0.1, charging: false, lowPower: false }),
      });
      await engine.start();

      clock.t = SLOT;
      expect(await engine.heartbeat()).toBe(0);
      expect(publisher.published).toHaveLength(0);
    });

    it('backfills every slot missed while the process was frozen', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));

      // Woken four slots later by the OS background task.
      clock.t = 4 * SLOT;
      const n = await engine.heartbeat();

      expect(n).toBe(4);
      expect(publisher.published).toHaveLength(5);
    });

    it('caps backfill rather than flooding the trail after a long outage', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));

      // A day asleep. Filling it would be ~288 duplicate points and would buy no privacy: the
      // arrival burst already reveals the outage.
      clock.t = 24 * 60 * 60_000;
      const n = await engine.heartbeat();

      expect(n).toBe(MAX_BACKFILL_MS / SLOT);
      expect(publisher.published).toHaveLength(1 + MAX_BACKFILL_MS / SLOT);
    });

    it('does nothing in live mode, which publishes per fix instead', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();
      clock.t = 0;
      await engine.ingest(fix(0));
      await engine.setLiveMode(true);

      clock.t = SLOT;
      expect(await engine.heartbeat()).toBe(0);
      expect(publisher.published).toHaveLength(1);
    });
  });

  describe('live mode', () => {
    it('publishes every fix while live', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();
      await engine.setLiveMode(true);

      for (const offset of [0, 4_000, 8_000]) {
        clock.t = offset;
        await engine.ingest(fix(offset));
      }

      expect(publisher.published).toHaveLength(3);
    });

    it('re-anchors the slot grid on exit so it does not backfill the live window', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      await engine.setLiveMode(true);

      // Three slots' worth of real-time publishing.
      for (let t = 0; t <= 3 * SLOT; t += 30_000) {
        clock.t = t;
        await engine.ingest(fix(t));
      }
      const duringLive = publisher.published.length;

      await engine.setLiveMode(false);
      clock.t = 3 * SLOT + 1_000;
      expect(await engine.heartbeat()).toBe(0);
      expect(publisher.published).toHaveLength(duringLive);
    });
  });

  describe('setIntervalMs', () => {
    it('re-paces publishing to the new interval', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      clock.t = 0;
      await engine.ingest(fix(0));
      await engine.setIntervalMs(60_000);

      clock.t = 60_000;
      await engine.heartbeat();
      clock.t = 120_000;
      await engine.heartbeat();

      expect(publisher.published).toHaveLength(3);
    });

    it('shortening the interval does not backfill slots that never elapsed', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      // Published on the 15-minute grid, then switched to 1 minute. The old slot index means
      // nothing against the new interval — re-gridding is what stops a burst here.
      await engine.setIntervalMs(900_000);
      clock.t = 900_000;
      await engine.ingest(fix(clock.t));
      const before = publisher.published.length;

      await engine.setIntervalMs(60_000);
      expect(publisher.published).toHaveLength(before);

      clock.t += 60_000;
      expect(await engine.heartbeat()).toBe(1);
    });

    it('lengthening the interval does not stall publishing', async () => {
      const { publisher, clock, engine } = harness({ ready: true });
      await engine.start();

      await engine.setIntervalMs(60_000);
      clock.t = 60_000;
      await engine.ingest(fix(clock.t));
      const before = publisher.published.length;

      await engine.setIntervalMs(900_000);
      clock.t += 900_000;
      await engine.heartbeat();

      expect(publisher.published).toHaveLength(before + 1);
    });

    it('reports the new cadence so the OS gets re-armed', async () => {
      const { engine } = harness({ ready: true });
      await engine.start();

      const decision = await engine.setIntervalMs(60_000);
      expect(decision.timeIntervalMs).toBe(60_000);
      expect(engine.getState().decision?.timeIntervalMs).toBe(60_000);
    });
  });
});
