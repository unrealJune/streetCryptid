import { DEFAULT_FIX_QUALITY_CONFIG } from '../fix-quality';
import {
  AMBIENT_DELIVERY_INTERVAL_MS,
  AMBIENT_DISTANCE_INTERVAL_M,
  benchmarkProfileOverrides,
  createSamplingPolicy,
  DEFAULT_SAMPLING_CONFIG,
} from '../sampling-policy';
import type { AccuracyTier, BatteryState } from '../types';

const healthy: BatteryState = { level: 0.9, charging: false, lowPower: false };
const low: BatteryState = { level: 0.1, charging: false, lowPower: false };
const lowPower: BatteryState = { level: 0.9, charging: false, lowPower: true };
const charging: BatteryState = { level: 0.1, charging: true, lowPower: true };
const critical: BatteryState = { level: 0.04, charging: false, lowPower: false };

describe('createSamplingPolicy', () => {
  it('exposes the merged config', () => {
    const policy = createSamplingPolicy({ intervalMs: 60_000 });
    expect(policy.config.intervalMs).toBe(60_000);
    expect(policy.config.normalAccuracy).toBe(DEFAULT_SAMPLING_CONFIG.normalAccuracy);
  });

  it.each([
    ['battery', 100, 300_000],
    ['balanced', 50, 60_000],
    ['fidelity', 25, 30_000],
  ] as const)('provides the %s simulator benchmark profile', (profile, distance, delivery) => {
    const policy = createSamplingPolicy(benchmarkProfileOverrides(profile));
    const decision = policy.decide({ battery: healthy });
    expect(decision.distanceIntervalM).toBe(distance);
    expect(decision.deferredUpdatesIntervalMs).toBe(delivery);
  });

  it('defaults to a 5-minute cadence', () => {
    expect(createSamplingPolicy().decide({ battery: healthy }).timeIntervalMs).toBe(300_000);
  });

  // The core privacy property: nothing about the device's state may move the interval, because the
  // interval is visible to the stash even though the payload is not.
  it('publishes at the configured interval under every battery state', () => {
    const policy = createSamplingPolicy({ intervalMs: 300_000 });
    for (const battery of [healthy, low, lowPower, charging, critical]) {
      expect(policy.decide({ battery }).timeIntervalMs).toBe(300_000);
    }
  });

  it('uses a moderate movement filter so iOS does not run continuous GPS', () => {
    const policy = createSamplingPolicy();
    for (const battery of [healthy, low, lowPower, charging]) {
      expect(policy.decide({ battery }).distanceIntervalM).toBe(AMBIENT_DISTANCE_INTERVAL_M);
      expect(policy.decide({ battery }).distanceIntervalM).toBe(50);
    }
  });

  it('batches ambient background callbacks to at most one JS wake per minute while moving', () => {
    const policy = createSamplingPolicy();
    for (const battery of [healthy, low, lowPower, charging]) {
      expect(policy.decide({ battery }).deferredUpdatesIntervalMs).toBe(
        AMBIENT_DELIVERY_INTERVAL_MS
      );
    }
  });

  it('answers a low battery with accuracy, never with cadence', () => {
    // Configured explicitly: the shipped tiers are equal (see the default-config test below), so
    // this exercises the mechanism rather than today's values.
    const policy = createSamplingPolicy({
      normalAccuracy: 'high',
      lowBatteryAccuracy: 'balanced',
    });
    expect(policy.decide({ battery: healthy }).accuracy).toBe('high');
    expect(policy.decide({ battery: low }).accuracy).toBe('balanced');
    expect(policy.decide({ battery: low }).timeIntervalMs).toBe(
      policy.decide({ battery: healthy }).timeIntervalMs
    );
  });

  it('treats Low-Power Mode like a low battery', () => {
    const policy = createSamplingPolicy({ lowBatteryAccuracy: 'low' });
    expect(policy.decide({ battery: lowPower }).accuracy).toBe('low');
  });

  it('charging cancels the low-battery penalty entirely', () => {
    const policy = createSamplingPolicy({ lowBatteryAccuracy: 'low' });
    expect(policy.decide({ battery: charging }).accuracy).toBe('balanced');
  });

  // Requesting a tier coarser than the confidence gate accepts would burn battery on fixes we then
  // throw away, and a low battery would show up as the trail quietly freezing.
  it('never requests a tier coarser than the confidence gate accepts', () => {
    const usable: AccuracyTier[] = ['balanced', 'high', 'highest'];
    expect(usable).toContain(DEFAULT_SAMPLING_CONFIG.normalAccuracy);
    expect(usable).toContain(DEFAULT_SAMPLING_CONFIG.lowBatteryAccuracy);
    expect(DEFAULT_FIX_QUALITY_CONFIG.maxAccuracyM).toBeGreaterThanOrEqual(100);
  });

  it('suspends outright when critically low and not charging', () => {
    // A hard stop, not a slow-down: it looks like the phone died rather than encoding the charge
    // level in the cadence.
    expect(createSamplingPolicy().decide({ battery: critical }).active).toBe(false);
  });

  it('stays active when critically low but charging', () => {
    const plugged: BatteryState = { level: 0.04, charging: true, lowPower: false };
    expect(createSamplingPolicy().decide({ battery: plugged }).active).toBe(true);
  });

  it('live mode uses the real-time cadence regardless of Low-Power Mode', () => {
    const d = createSamplingPolicy().decide({ battery: lowPower, live: true });
    expect(d.timeIntervalMs).toBe(4_000);
    expect(d.accuracy).toBe('high');
    // 25 m, not 5 m: `timeIntervalMs` above is Android-only, so on iOS this filter alone paced live
    // mode and a car tripped it about once a second. The engine's `liveMinPublishMs` is the real
    // bound now; this just stops the OS waking us for movement no map dot could show.
    expect(d.distanceIntervalM).toBe(25);
    expect(d.active).toBe(true);
  });

  it('live mode still yields to a critically low, unplugged battery', () => {
    expect(createSamplingPolicy().decide({ battery: critical, live: true }).active).toBe(false);
  });

  describe('setIntervalMs', () => {
    it('re-paces subsequent decisions and is visible on config', () => {
      const policy = createSamplingPolicy();
      policy.setIntervalMs(60_000);
      expect(policy.config.intervalMs).toBe(60_000);
      expect(policy.decide({ battery: healthy }).timeIntervalMs).toBe(60_000);
    });

    it('ignores nonsense rather than producing an off-grid interval', () => {
      const policy = createSamplingPolicy({ intervalMs: 300_000 });
      policy.setIntervalMs(0);
      policy.setIntervalMs(-1);
      policy.setIntervalMs(Number.NaN);
      expect(policy.config.intervalMs).toBe(300_000);
    });
  });
});
