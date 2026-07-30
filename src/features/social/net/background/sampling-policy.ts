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
 *  - `distanceIntervalM` is 0 outside live mode: a distance filter is a motion filter.
 */
export interface SamplingInputs {
  battery: BatteryState;
  /**
   * Live-tracking override: when true, use the real-time `live*` cadence and bypass the low-battery
   * accuracy degradation (only the critical-battery suspend still applies). Set on demand when a
   * friend is actively watching; see `LocationSharingService.setLiveTracking`. Deliberately visible
   * on the wire — see {@link SamplingConfig.liveIntervalMs}.
   */
  live?: boolean;
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

/** The default cadence, and the middle option offered in settings. */
export const DEFAULT_SHARE_INTERVAL_MS = 5 * 60_000;

/**
 * Defaults for an *ambient* "friends on a map" sharer (Life360 / Find-My class), not a turn-by-turn
 * navigator. One fix every 5 minutes at balanced (~100m) accuracy, which a map dot reads fine, and
 * which the service can sustain indefinitely in the background. A short, on-demand live mode (see
 * {@link SamplingInputs.live}) covers the real-time case without paying its battery cost 24/7.
 */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  intervalMs: DEFAULT_SHARE_INTERVAL_MS,
  lowBatteryThreshold: 0.2,
  normalAccuracy: 'balanced',
  // Not `low`. That tier is nominally accurate to the kilometre, which is both useless on a friend
  // map and coarse enough that the confidence gate (`fix-quality.ts`, 150 m) would reject what it
  // produced — we would burn battery sampling fixes we then threw away, and a low battery would
  // manifest as the trail quietly freezing. Neither tier may be coarser than `maxAccuracyM`.
  lowBatteryAccuracy: 'balanced',
  suspendBelowLevel: 0.05,
  liveIntervalMs: 4_000,
  liveDistanceM: 5,
  liveAccuracy: 'high',
};

/** Build a policy from a (partial) config merged over {@link DEFAULT_SAMPLING_CONFIG}. */
export function createSamplingPolicy(config?: Partial<SamplingConfig>): SamplingPolicy {
  const merged: SamplingConfig = { ...DEFAULT_SAMPLING_CONFIG, ...config };

  /** Critical-battery cutoff — the only backoff that still applies in live mode. */
  const criticallyLow = (battery: BatteryState): boolean =>
    battery.level < merged.suspendBelowLevel && !battery.charging;

  const decide = ({ battery, live }: SamplingInputs): SamplingDecision => {
    if (live) {
      return {
        accuracy: merged.liveAccuracy,
        timeIntervalMs: merged.liveIntervalMs,
        distanceIntervalM: merged.liveDistanceM,
        deferredUpdatesIntervalMs: 0, // real-time: never batch/defer
        active: !criticallyLow(battery),
      };
    }

    const lowBattery =
      !battery.charging && (battery.level <= merged.lowBatteryThreshold || battery.lowPower);
    const accuracy: AccuracyTier = lowBattery ? merged.lowBatteryAccuracy : merged.normalAccuracy;

    return {
      accuracy,
      // Constant, whatever the battery says. The only battery response is the accuracy tier above
      // and the hard suspend below; stretching the interval would put the charge level on the wire.
      timeIntervalMs: merged.intervalMs,
      // No distance filter: it would gate delivery on movement, which is the leak we are closing.
      distanceIntervalM: 0,
      // No deferred batching either — it would coalesce quiet periods into bursts and re-introduce
      // the same motion signal at the delivery layer.
      deferredUpdatesIntervalMs: 0,
      active: !criticallyLow(battery),
    };
  };

  const setIntervalMs = (intervalMs: number): void => {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    merged.intervalMs = intervalMs;
  };

  return { decide, setIntervalMs, config: merged };
}
