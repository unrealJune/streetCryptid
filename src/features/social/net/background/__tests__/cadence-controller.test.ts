import type { BatterySource } from '../battery-source';
import type { BackgroundStartConfig } from '../background-task';
import {
  activityForMotion,
  cadenceDiffers,
  cfgFromDecision,
  createCadenceController,
  type CadenceEngine,
  type CadenceNotification,
} from '../cadence-controller';
import type { EngineState } from '../location-engine';
import { createSamplingPolicy } from '../sampling-policy';
import type { BatteryState, MotionState } from '../types';

const NOTIF: CadenceNotification = { title: 'streetCryptid', body: 'body', color: '#C6791A' };
const policy = createSamplingPolicy();
const fullBattery: BatteryState = { level: 1, charging: false, lowPower: false };

/** An EngineState carrying the decision the policy makes for `motion`. */
function stateFor(motion: MotionState): EngineState {
  return {
    status: 'running',
    lastFixAt: 0,
    decision: policy.decide({ motion, battery: fullBattery }),
    motion,
    pending: 0,
    error: null,
  };
}

function cfgFor(motion: MotionState): BackgroundStartConfig {
  return cfgFromDecision(policy.decide({ motion, battery: fullBattery }), motion, NOTIF);
}

function fakeEngine() {
  const listeners = new Set<(s: EngineState) => void>();
  let reevaluateCount = 0;
  return {
    onState(cb: (s: EngineState) => void): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async reevaluate(): Promise<void> {
      reevaluateCount += 1;
    },
    emit(state: EngineState): void {
      listeners.forEach((l) => l(state));
    },
    get reevaluateCount(): number {
      return reevaluateCount;
    },
  } satisfies CadenceEngine & { emit(s: EngineState): void; reevaluateCount: number };
}

function fakeProvider() {
  const calls: BackgroundStartConfig[] = [];
  let resolvers: (() => void)[] = [];
  return {
    calls,
    async reprogram(cfg: BackgroundStartConfig): Promise<void> {
      calls.push(cfg);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    },
    /** Resolve the oldest in-flight reprogram. */
    release(): void {
      resolvers.shift()?.();
    },
    /** Resolve every in-flight reprogram. */
    releaseAll(): void {
      const pending = resolvers;
      resolvers = [];
      pending.forEach((r) => r());
    },
  };
}

function fakeBattery(): BatterySource & { fire(): void } {
  const subs = new Set<() => void>();
  return {
    async read(): Promise<BatteryState> {
      return fullBattery;
    },
    subscribe(onChange: () => void): () => void {
      subs.add(onChange);
      return () => subs.delete(onChange);
    },
    fire(): void {
      subs.forEach((s) => s());
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('cadence pure helpers', () => {
  it('maps motion to an iOS activity hint', () => {
    expect(activityForMotion('walking')).toBe('fitness');
    expect(activityForMotion('driving')).toBe('automotive');
    expect(activityForMotion('stationary')).toBe('other');
    expect(activityForMotion('unknown')).toBe('other');
  });

  it('cfgFromDecision carries accuracy, cadence, activity, disabled auto-pause and notification', () => {
    const cfg = cfgFor('walking');
    expect(cfg.accuracy).toBe('balanced');
    expect(cfg.activityType).toBe('fitness');
    // Auto-pause is always OFF so iOS keeps delivering background fixes (does not reliably resume).
    expect(cfg.pausesUpdatesAutomatically).toBe(false);
    expect(cfg.notificationTitle).toBe('streetCryptid');
    expect(cfg.notificationColor).toBe('#C6791A');
  });

  it('cadenceDiffers ignores notification text but catches cadence + activity changes', () => {
    expect(cadenceDiffers(cfgFor('walking'), cfgFor('walking'))).toBe(false);
    expect(cadenceDiffers(cfgFor('walking'), cfgFor('stationary'))).toBe(true);
    expect(
      cadenceDiffers(cfgFor('walking'), { ...cfgFor('walking'), notificationBody: 'different' })
    ).toBe(false);
  });
});

describe('cadence controller', () => {
  it('re-arms the OS when the decision materially changes', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
    }).start();

    engine.emit(stateFor('walking'));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor('stationary'));
    provider.releaseAll();
    await tick();

    // Walking and stationary share balanced accuracy here, so the cadence change is the interval.
    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([45_000, 180_000]);
    await stop();
  });

  it('does not re-arm when the cadence is unchanged', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
    }).start();

    engine.emit(stateFor('walking'));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor('walking')); // same cadence, e.g. only pending changed
    provider.releaseAll();
    await tick();

    expect(provider.calls).toHaveLength(1);
    await stop();
  });

  it('does not re-arm on the seeded cadence', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
      seed: cfgFor('walking'),
    }).start();

    engine.emit(stateFor('walking'));
    await tick();

    expect(provider.calls).toHaveLength(0);
    await stop();
  });

  it('preserves caller overrides across policy-driven re-arms', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
      overrides: { timeIntervalMs: 60_000 },
    }).start();

    engine.emit(stateFor('walking'));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor('driving'));
    provider.releaseAll();
    await tick();

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([60_000, 60_000]);
    expect(provider.calls.map((c) => c.accuracy)).toEqual(['balanced', 'high']);
    await stop();
  });

  it('coalesces bursts to the latest target while a re-arm is in flight', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
    }).start();

    engine.emit(stateFor('walking')); // starts reprogram(walking), now in flight
    engine.emit(stateFor('stationary')); // queued
    engine.emit(stateFor('driving')); // supersedes stationary as the desired target
    provider.release(); // resolve walking → converge to driving, skipping stationary
    await tick();
    provider.release(); // resolve driving
    await tick();

    expect(provider.calls.map((c) => c.accuracy)).toEqual(['balanced', 'high']); // walking, driving
    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([45_000, 18_000]); // stationary skipped
    await stop();
  });

  it('waits for an in-flight re-arm and drops queued targets when stopped', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
    }).start();

    engine.emit(stateFor('walking')); // in flight
    engine.emit(stateFor('driving')); // queued
    const stopped = stop();
    provider.release(); // let the in-flight arm finish
    await stopped;

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([45_000]);
  });

  it('re-evaluates the engine on a power event', async () => {
    const engine = fakeEngine();
    const battery = fakeBattery();
    const stop = createCadenceController({
      engine,
      provider: fakeProvider(),
      battery,
      notification: NOTIF,
    }).start();

    battery.fire();
    await tick();

    expect(engine.reevaluateCount).toBe(1);
    await stop();
  });

  it('stop() detaches state and power listeners', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const battery = fakeBattery();
    const stop = createCadenceController({
      engine,
      provider,
      battery,
      notification: NOTIF,
    }).start();
    await stop();

    engine.emit(stateFor('walking'));
    battery.fire();
    await tick();

    expect(provider.calls).toHaveLength(0);
    expect(engine.reevaluateCount).toBe(0);
  });
});
