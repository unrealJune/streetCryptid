import type { LocationFix } from '../../../core/types';
import { createSamplingPolicy, DEFAULT_SAMPLING_CONFIG, deriveMotion } from '../sampling-policy';
import type { BatteryState } from '../types';

const M_PER_DEG_LAT = 6_371_000 * (Math.PI / 180);

function fixAt(lat: number, lon = 0): LocationFix {
  return { lat, lon, accuracyM: 5, headingDeg: 0, ts: 0 };
}

/** Build a `next` fix `metres` north of `prev`. */
function north(prev: LocationFix, metres: number): LocationFix {
  return fixAt(prev.lat + metres / M_PER_DEG_LAT, prev.lon);
}

const healthy: BatteryState = { level: 0.9, charging: false, lowPower: false };

describe('deriveMotion', () => {
  const base = fixAt(37.0);

  it('returns unknown with no previous fix', () => {
    expect(deriveMotion(null, base, 1000)).toBe('unknown');
  });

  it('returns unknown when dt <= 0', () => {
    expect(deriveMotion(base, north(base, 10), 0)).toBe('unknown');
    expect(deriveMotion(base, north(base, 10), -100)).toBe('unknown');
  });

  it('classifies stationary below 0.5 m/s', () => {
    expect(deriveMotion(base, north(base, 0.2), 1000)).toBe('stationary');
  });

  it('classifies walking between 0.5 and 3 m/s', () => {
    expect(deriveMotion(base, north(base, 1.5), 1000)).toBe('walking');
  });

  it('classifies driving at or above 3 m/s', () => {
    expect(deriveMotion(base, north(base, 10), 1000)).toBe('driving');
  });
});

describe('createSamplingPolicy', () => {
  it('exposes the merged config', () => {
    const policy = createSamplingPolicy({ baseIntervalMs: 20_000 });
    expect(policy.config.baseIntervalMs).toBe(20_000);
    expect(policy.config.baseDistanceM).toBe(DEFAULT_SAMPLING_CONFIG.baseDistanceM);
  });

  it('uses base cadence + walking accuracy while walking', () => {
    const policy = createSamplingPolicy();
    const d = policy.decide({ motion: 'walking', battery: healthy });
    expect(d.timeIntervalMs).toBe(45_000);
    expect(d.accuracy).toBe('balanced');
    expect(d.distanceIntervalM).toBe(40);
    // balanced accuracy is batchable, so iOS defers/coalesces at the cadence interval.
    expect(d.deferredUpdatesIntervalMs).toBe(45_000);
    expect(d.active).toBe(true);
  });

  it('backs off cadence while stationary', () => {
    const policy = createSamplingPolicy();
    const d = policy.decide({ motion: 'stationary', battery: healthy });
    expect(d.timeIntervalMs).toBe(180_000);
    expect(d.accuracy).toBe('balanced');
    expect(d.distanceIntervalM).toBe(80);
    expect(d.deferredUpdatesIntervalMs).toBe(180_000);
  });

  it('tightens cadence and keeps high accuracy while driving', () => {
    const policy = createSamplingPolicy();
    const d = policy.decide({ motion: 'driving', battery: healthy });
    expect(d.timeIntervalMs).toBe(18_000);
    expect(d.accuracy).toBe('high');
    // high accuracy is not batchable — driving stays timely.
    expect(d.deferredUpdatesIntervalMs).toBe(0);
  });

  it('applies low-battery backoff and resting accuracy', () => {
    const policy = createSamplingPolicy();
    const low: BatteryState = { level: 0.1, charging: false, lowPower: false };
    const d = policy.decide({ motion: 'walking', battery: low });
    expect(d.timeIntervalMs).toBe(135_000);
    expect(d.accuracy).toBe('balanced');
    expect(d.deferredUpdatesIntervalMs).toBe(135_000);
  });

  it('applies low-battery backoff for low-power mode', () => {
    const policy = createSamplingPolicy();
    const lp: BatteryState = { level: 0.9, charging: false, lowPower: true };
    const d = policy.decide({ motion: 'walking', battery: lp });
    expect(d.timeIntervalMs).toBe(135_000);
    expect(d.accuracy).toBe('balanced');
  });

  it('charging cancels the low-battery penalty entirely', () => {
    const policy = createSamplingPolicy();
    const charging: BatteryState = { level: 0.1, charging: true, lowPower: true };
    const d = policy.decide({ motion: 'walking', battery: charging });
    expect(d.timeIntervalMs).toBe(45_000);
    expect(d.accuracy).toBe('balanced');
  });

  it('live mode uses the real-time cadence regardless of motion or Low-Power Mode', () => {
    const policy = createSamplingPolicy();
    const lp: BatteryState = { level: 0.1, charging: false, lowPower: true };
    const d = policy.decide({ motion: 'stationary', battery: lp, live: true });
    expect(d.timeIntervalMs).toBe(4_000);
    expect(d.accuracy).toBe('high');
    expect(d.distanceIntervalM).toBe(5);
    expect(d.deferredUpdatesIntervalMs).toBe(0);
    expect(d.active).toBe(true);
  });

  it('live mode still yields to a critically low, unplugged battery', () => {
    const policy = createSamplingPolicy();
    const critical: BatteryState = { level: 0.04, charging: false, lowPower: false };
    const d = policy.decide({ motion: 'walking', battery: critical, live: true });
    expect(d.active).toBe(false);
  });

  it('suspends when critically low + stationary + not charging', () => {
    const policy = createSamplingPolicy();
    const critical: BatteryState = { level: 0.04, charging: false, lowPower: false };
    const d = policy.decide({ motion: 'stationary', battery: critical });
    expect(d.active).toBe(false);
  });

  it('stays active when critically low but charging', () => {
    const policy = createSamplingPolicy();
    const critical: BatteryState = { level: 0.04, charging: true, lowPower: false };
    const d = policy.decide({ motion: 'stationary', battery: critical });
    expect(d.active).toBe(true);
  });

  it('clamps the final interval to maxIntervalMs', () => {
    const policy = createSamplingPolicy({
      baseIntervalMs: 200_000,
      maxIntervalMs: 250_000,
      stationaryMultiplier: 4,
    });
    const d = policy.decide({ motion: 'stationary', battery: healthy });
    expect(d.timeIntervalMs).toBe(250_000);
  });
});
