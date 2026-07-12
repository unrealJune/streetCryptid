import type { LocationFix } from '../../core/types';
import type {
  AccuracyTier,
  BatteryState,
  MotionState,
  SamplingConfig,
  SamplingDecision,
} from './types';

/**
 * Battery- and motion-aware sampling policy. Pure and synchronous so it is fully unit-tested
 * with no native deps. The engine calls {@link SamplingPolicy.decide} whenever motion or
 * battery changes and re-programs the OS location updates accordingly.
 *
 * Design contract (see docs/social/ARCHITECTURE.md §9 — "background execution"):
 *  - stationary ⇒ back off cadence by `stationaryMultiplier`, drop to `restingAccuracy`.
 *  - driving    ⇒ tighten cadence by `drivingMultiplier`, use `movingAccuracy`.
 *  - battery ≤ `lowBatteryThreshold` OR `lowPower`/battery-saver ⇒ multiply interval by
 *    `lowBatteryMultiplier` and prefer `restingAccuracy`. `charging` cancels the battery penalty.
 *  - battery < `suspendBelowLevel` AND stationary AND not charging ⇒ `active: false`.
 *  - the resulting interval is clamped to `maxIntervalMs`.
 */
export interface SamplingInputs {
  motion: MotionState;
  battery: BatteryState;
  /**
   * Live-tracking override: when true, use the real-time `live*` cadence regardless of motion, and
   * bypass the stationary/low-battery backoff (only the critical-battery suspend still applies). Set
   * on demand when a friend is actively watching; see `LocationSharingService.setLiveTracking`.
   */
  live?: boolean;
}

export interface SamplingPolicy {
  decide(inputs: SamplingInputs): SamplingDecision;
  readonly config: SamplingConfig;
}

/**
 * Defaults for an *ambient* "friends on a map" sharer (Life360 / Find-My class), not a turn-by-turn
 * navigator. Moving cadence is deliberately calm — ~45s walking at balanced (~100m) accuracy, which
 * a map dot reads fine — since the service runs indefinitely in the background. Driving tightens and
 * keeps high accuracy; stationary is displacement-gated to near-zero. A short, on-demand live mode
 * (see {@link SamplingInputs.live}) covers the real-time case without paying its battery cost 24/7.
 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  baseIntervalMs: 45_000,
  baseDistanceM: 40,
  stationaryMultiplier: 4,
  drivingMultiplier: 0.4,
  lowBatteryMultiplier: 3,
  lowBatteryThreshold: 0.2,
  maxIntervalMs: 5 * 60_000,
  movingAccuracy: 'balanced',
  drivingAccuracy: 'high',
  restingAccuracy: 'balanced',
  suspendBelowLevel: 0.05,
  liveIntervalMs: 4_000,
  liveDistanceM: 5,
  liveAccuracy: 'high',
};

/** Great-circle distance between two fixes in metres. Private. */
function haversineMetres(a: LocationFix, b: LocationFix): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Classify motion from two successive fixes. Pure helper the engine uses to feed
 * {@link SamplingInputs.motion}. Thresholds: < ~0.5 m/s → stationary, < ~3 m/s → walking,
 * otherwise driving. Returns `unknown` when there is no previous fix or dt ≤ 0.
 */
export function deriveMotion(
  prev: LocationFix | null,
  next: LocationFix,
  dtMs: number
): MotionState {
  if (prev === null || dtMs <= 0) return 'unknown';
  const speed = haversineMetres(prev, next) / (dtMs / 1000);
  if (speed < 0.5) return 'stationary';
  if (speed < 3.0) return 'walking';
  return 'driving';
}

/** Build a policy from a (partial) config merged over {@link DEFAULT_SAMPLING_CONFIG}. */
export function createSamplingPolicy(config?: Partial<SamplingConfig>): SamplingPolicy {
  const merged: SamplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...config };

  /** Critical-battery cutoff — the only backoff that still applies in live mode. */
  const criticallyLow = (battery: BatteryState): boolean =>
    battery.level < merged.suspendBelowLevel && !battery.charging;

  const decide = ({ motion, battery, live }: SamplingInputs): SamplingDecision => {
    if (live) {
      return {
        accuracy: merged.liveAccuracy,
        timeIntervalMs: Math.min(merged.liveIntervalMs, merged.maxIntervalMs),
        distanceIntervalM: merged.liveDistanceM,
        deferredUpdatesIntervalMs: 0, // real-time: never batch/defer
        active: !criticallyLow(battery),
      };
    }

    let interval = merged.baseIntervalMs;
    let accuracy: AccuracyTier = merged.movingAccuracy;
    let distanceIntervalM = merged.baseDistanceM;

    if (motion === 'stationary') {
      interval *= merged.stationaryMultiplier;
      accuracy = merged.restingAccuracy;
      distanceIntervalM = merged.baseDistanceM * 2;
    } else if (motion === 'driving') {
      interval *= merged.drivingMultiplier;
      accuracy = merged.drivingAccuracy;
    } else {
      accuracy = merged.movingAccuracy;
    }

    const lowBattery =
      !battery.charging && (battery.level <= merged.lowBatteryThreshold || battery.lowPower);
    if (lowBattery) {
      interval *= merged.lowBatteryMultiplier;
      accuracy = merged.restingAccuracy;
    }

    const timeIntervalMs = Math.min(Math.round(interval), merged.maxIntervalMs);

    const active = !(
      battery.level < merged.suspendBelowLevel &&
      motion === 'stationary' &&
      !battery.charging
    );

    const batchable = accuracy === 'balanced' || accuracy === 'low' || accuracy === 'lowest';
    const deferredUpdatesIntervalMs = batchable ? timeIntervalMs : 0;

    return {
      accuracy,
      timeIntervalMs,
      distanceIntervalM,
      deferredUpdatesIntervalMs,
      active,
    };
  };

  return { decide, config: merged };
}
