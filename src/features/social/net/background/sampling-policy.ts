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
}

export interface SamplingPolicy {
  decide(inputs: SamplingInputs): SamplingDecision;
  readonly config: SamplingConfig;
}

/** Sensible defaults for a "live location + trails" phone service. */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  baseIntervalMs: 15_000,
  baseDistanceM: 25,
  stationaryMultiplier: 4,
  drivingMultiplier: 0.5,
  lowBatteryMultiplier: 3,
  lowBatteryThreshold: 0.2,
  maxIntervalMs: 5 * 60_000,
  movingAccuracy: 'high',
  restingAccuracy: 'balanced',
  suspendBelowLevel: 0.05,
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

  const decide = ({ motion, battery }: SamplingInputs): SamplingDecision => {
    let interval = merged.baseIntervalMs;
    let accuracy: AccuracyTier = merged.movingAccuracy;
    let distanceIntervalM = merged.baseDistanceM;

    if (motion === 'stationary') {
      interval *= merged.stationaryMultiplier;
      accuracy = merged.restingAccuracy;
      distanceIntervalM = merged.baseDistanceM * 2;
    } else if (motion === 'driving') {
      interval *= merged.drivingMultiplier;
      accuracy = merged.movingAccuracy;
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
