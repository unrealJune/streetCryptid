import type { AccuracyTier, BatteryState, SamplingConfig, SamplingDecision } from './types';

/**
 * Fixed-cadence sampling policy. Pure and synchronous so it is fully unit-tested with no native
 * deps. The engine calls {@link SamplingPolicy.decide} on each fix and on power events, and the
 * cadence controller re-programs the OS when the result materially changes.
 *
 * Design contract (see docs/social/ARCHITECTURE.md §9 — "background execution"):
 *  - the interval is `config.intervalMs`, **always**. It does not vary with movement, with
 *    foreground/background state, or with battery. Timing is observable to the trail-stash even
 *    though payloads are not, so a cadence that tracked activity would leak the activity.
 *  - battery ≤ `lowBatteryThreshold` OR `lowPower`/battery-saver ⇒ degrade to `lowBatteryAccuracy`.
 *    `charging` cancels the penalty. Accuracy is not timing, so this is safe to vary.
 *  - battery < `suspendBelowLevel` AND not charging ⇒ `active: false` — a hard stop indistinguishable
 *    from the phone dying, rather than a slow-down that would encode the battery level in the cadence.
 *  - ambient OS sampling is movement-driven and deferred. Publishing still uses the slot grid, but
 *    a stationary phone does not keep GPS and the JS runtime awake merely to repeat one coordinate.
 */
export interface SamplingInputs {
  battery: BatteryState;
}

export interface SamplingPolicy {
  decide(inputs: SamplingInputs): SamplingDecision;
  /**
   * Change the fixed cadence at runtime (the user picked a different interval in settings).
   * Mutates {@link config} in place so holders — notably the engine's slot grid — see one source of
   * truth rather than caching a stale copy.
   */
  setIntervalMs(intervalMs: number): void;
  readonly config: SamplingConfig;
}

/**
 * The publish cadence. Fixed for everyone: the interval is the one property of a sealed envelope the
 * trail-stash can read, so a per-user choice was a few bits of identifier on the wire, and changing it
 * was also how a phone stopped publishing altogether (see `gate::regrid`). The setting is gone.
 */
export const SHARE_INTERVAL_MS = 5 * 60_000;
export const AMBIENT_DISTANCE_INTERVAL_M = 50;
export const AMBIENT_DELIVERY_INTERVAL_MS = 60_000;

export type IosLocationBenchmarkProfile = 'battery' | 'balanced' | 'fidelity';

/** Dev-only simulator profiles; production always uses the balanced defaults above. */
export function benchmarkProfileOverrides(
  profile: string | null
): Partial<SamplingConfig> | undefined {
  switch (profile) {
    case 'battery':
      return { ambientDistanceM: 100, ambientDeliveryIntervalMs: 5 * 60_000 };
    case 'balanced':
      return {
        ambientDistanceM: AMBIENT_DISTANCE_INTERVAL_M,
        ambientDeliveryIntervalMs: AMBIENT_DELIVERY_INTERVAL_MS,
      };
    case 'fidelity':
      return { ambientDistanceM: 25, ambientDeliveryIntervalMs: 30_000 };
    default:
      return undefined;
  }
}

/**
 * Defaults for an *ambient* "friends on a map" sharer (Life360 / Find-My class), not a turn-by-turn
 * navigator. One fix every 5 minutes at balanced (~100m) accuracy, which a map dot reads fine, and
 * which the service can sustain indefinitely in the background.
 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  intervalMs: SHARE_INTERVAL_MS,
  ambientDistanceM: AMBIENT_DISTANCE_INTERVAL_M,
  ambientDeliveryIntervalMs: AMBIENT_DELIVERY_INTERVAL_MS,
  lowBatteryThreshold: 0.2,
  normalAccuracy: 'balanced',
  // Not `low`. That tier is nominally accurate to the kilometre, which is both useless on a friend
  // map and coarse enough that the confidence gate (`fix-quality.ts`, 150 m) would reject what it
  // produced — we would burn battery sampling fixes we then threw away, and a low battery would
  // manifest as the trail quietly freezing. Neither tier may be coarser than `maxAccuracyM`.
  lowBatteryAccuracy: 'balanced',
  suspendBelowLevel: 0.05,
};

/** Build a policy from a (partial) config merged over {@link DEFAULT_SAMPLING_CONFIG}. */
export function createSamplingPolicy(config?: Partial<SamplingConfig>): SamplingPolicy {
  const merged: SamplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...config };

  /** Critical-battery cutoff: a hard stop rather than a slow-down. */
  const criticallyLow = (battery: BatteryState): boolean =>
    battery.level < merged.suspendBelowLevel && !battery.charging;

  const decide = ({ battery }: SamplingInputs): SamplingDecision => {
    const lowBattery =
      !battery.charging && (battery.level <= merged.lowBatteryThreshold || battery.lowPower);
    const accuracy: AccuracyTier = lowBattery ? merged.lowBatteryAccuracy : merged.normalAccuracy;

    return {
      accuracy,
      // Constant, whatever the battery says. The only battery response is the accuracy tier above
      // and the hard suspend below; stretching the interval would put the charge level on the wire.
      timeIntervalMs: merged.intervalMs,
      // Standard Core Location ignores timeInterval on iOS, so distance is the hardware-facing
      // battery control. Expo then batches the callbacks so a car does not wake JS every 50 m.
      distanceIntervalM: merged.ambientDistanceM,
      deferredUpdatesIntervalMs: merged.ambientDeliveryIntervalMs,
      active: !criticallyLow(battery),
    };
  };

  const setIntervalMs = (intervalMs: number): void => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    merged.intervalMs = intervalMs;
  };

  return { decide, setIntervalMs, config: merged };
}
