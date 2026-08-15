import type { BatterySource } from '../battery-source';
import type { BackgroundStartConfig } from '../background-task';
import {
  cadenceDiffers,
  cfgFromDecision,
  createCadenceController,
  type CadenceEngine,
  type CadenceNotification,
} from '../cadence-controller';
import type { EngineState } from '../location-engine';
import { createSamplingPolicy } from '../sampling-policy';
import type { BatteryState } from '../types';

const NOTIF: CadenceNotification = { title: 'streetCryptid', body: 'body', color: '#C6791A' };
// Tiers set explicitly so a battery change is observable here. The shipped defaults deliberately
// use the same tier for both (nothing coarser than the confidence gate accepts), which would make
// these tests assert nothing about the controller's re-arm logic.
const policy = createSamplingPolicy({ normalAccuracy: 'balanced', lowBatteryAccuracy: 'low' });
const fullBattery: BatteryState = { level: 1, charging: false, lowPower: false };
const lowBattery: BatteryState = { level: 0.1, charging: false, lowPower: false };

/**
 * An EngineState carrying the decision the policy makes for `battery`. Battery is the only device
 * signal left that can move the OS config — and it moves accuracy, never the interval.
 */
function stateFor(battery: BatteryState, intervalMs?: number): EngineState {
  if (intervalMs !== undefined) policy.setIntervalMs(intervalMs);
  return {
    status: 'running',
    lastFixAt: 0,
    lastAcceptedFix: null,
    lastRejection: null,
    decision: policy.decide({ battery }),
    pending: 0,
    error: null,
  };
}

function cfgFor(battery: BatteryState, intervalMs?: number): BackgroundStartConfig {
  if (intervalMs !== undefined) policy.setIntervalMs(intervalMs);
  return cfgFromDecision(policy.decide({ battery }), NOTIF);
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

beforeEach(() => {
  policy.setIntervalMs(300_000);
});

describe('cadence pure helpers', () => {
  it('cfgFromDecision carries accuracy, cadence, ambient auto-pause and notification', () => {
    const cfg = cfgFor(fullBattery);
    expect(cfg.accuracy).toBe('balanced');
    expect(cfg.timeIntervalMs).toBe(300_000);
    expect(cfg.pausesUpdatesAutomatically).toBe(true);
    expect(cfg.notificationTitle).toBe('streetCryptid');
    expect(cfg.notificationColor).toBe('#C6791A');
  });

  it('pins the iOS activity hint, which used to be derived from movement', () => {
    expect(cfgFor(fullBattery).activityType).toBe('other');
    expect(cfgFor(lowBattery).activityType).toBe('other');
    expect(cfgFor(fullBattery, 60_000).activityType).toBe('other');
  });

  it('keeps the ambient OS movement filter stable across battery states', () => {
    expect(cfgFor(fullBattery).distanceIntervalM).toBe(50);
    expect(cfgFor(lowBattery).distanceIntervalM).toBe(50);
  });

  it('cadenceDiffers ignores notification text but catches accuracy + interval changes', () => {
    expect(cadenceDiffers(cfgFor(fullBattery), cfgFor(fullBattery))).toBe(false);
    expect(cadenceDiffers(cfgFor(fullBattery), cfgFor(lowBattery))).toBe(true);
    expect(cadenceDiffers(cfgFor(fullBattery, 300_000), cfgFor(fullBattery, 60_000))).toBe(true);
    expect(
      cadenceDiffers(cfgFor(fullBattery), { ...cfgFor(fullBattery), notificationBody: 'other' })
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

    engine.emit(stateFor(fullBattery));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor(lowBattery));
    provider.releaseAll();
    await tick();

    expect(provider.calls.map((c) => c.accuracy)).toEqual(['balanced', 'low']);
    // ...and the battery change moved accuracy WITHOUT moving the cadence.
    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([300_000, 300_000]);
    await stop();
  });

  it('re-arms the OS when the user picks a different interval', async () => {
    const engine = fakeEngine();
    const provider = fakeProvider();
    const stop = createCadenceController({
      engine,
      provider,
      battery: fakeBattery(),
      notification: NOTIF,
    }).start();

    engine.emit(stateFor(fullBattery, 300_000));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor(fullBattery, 60_000));
    provider.releaseAll();
    await tick();

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([300_000, 60_000]);
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

    engine.emit(stateFor(fullBattery));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor(fullBattery)); // same cadence, e.g. only pending changed
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
      seed: cfgFor(fullBattery),
    }).start();

    engine.emit(stateFor(fullBattery));
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

    engine.emit(stateFor(fullBattery));
    provider.releaseAll();
    await tick();
    engine.emit(stateFor(lowBattery));
    provider.releaseAll();
    await tick();

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([60_000, 60_000]);
    expect(provider.calls.map((c) => c.accuracy)).toEqual(['balanced', 'low']);
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

    engine.emit(stateFor(fullBattery, 300_000)); // starts reprogram, now in flight
    engine.emit(stateFor(fullBattery, 900_000)); // queued
    engine.emit(stateFor(fullBattery, 60_000)); // supersedes 900_000 as the desired target
    provider.release(); // resolve the first → converge to 60_000, skipping 900_000
    await tick();
    provider.release();
    await tick();

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([300_000, 60_000]);
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

    engine.emit(stateFor(fullBattery, 300_000)); // in flight
    engine.emit(stateFor(fullBattery, 60_000)); // queued
    const stopped = stop();
    provider.release(); // let the in-flight arm finish
    await stopped;

    expect(provider.calls.map((c) => c.timeIntervalMs)).toEqual([300_000]);
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

    engine.emit(stateFor(fullBattery));
    battery.fire();
    await tick();

    expect(provider.calls).toHaveLength(0);
    expect(engine.reevaluateCount).toBe(0);
  });
});
