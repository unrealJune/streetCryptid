/**
 * Shared types for the background location subsystem — the phone service that samples GPS
 * (foreground and background) and feeds fixes into the live (gossip) + durable (docs) paths.
 * See docs/social/ARCHITECTURE.md §9. These types are deliberately native-free so the policy
 * and engine logic stay unit-testable without expo-location / expo-battery.
 */

/**
 * A snapshot of device power, injected so the policy stays pure/testable.
 *
 * Note what this deliberately does NOT do any more: influence *timing*. Battery may degrade
 * accuracy and, when critical, stop sampling outright, but it never changes the interval — see
 * the {@link SamplingConfig} header for why.
 */
export interface BatteryState {
  /** Charge fraction, 0..1. */
  level: number;
  /** Plugged in / charging. */
  charging: boolean;
  /** OS low-power mode engaged (iOS Low Power Mode / Android battery saver). */
  lowPower: boolean;
}

/**
 * Accuracy tier, mirroring expo-location's `Accuracy` enum but without importing it, so this
 * module tree has no native dependency. `background-provider.ts` maps these to the real enum.
 */
export type AccuracyTier = 'lowest' | 'low' | 'balanced' | 'high' | 'highest';

/**
 * iOS activity hint, mirroring expo-location's `ActivityType` without importing it. Lets Core
 * Location tune power use (and, with `pausesUpdatesAutomatically`, auto-suspend GPS when the
 * device is stationary). `background-task.ts` maps these to the real enum; ignored on Android.
 */
export type ActivityKind = 'other' | 'fitness' | 'automotive' | 'navigation';

/**
 * Tunables for {@link SamplingPolicy}; all durations in ms, distances in metres.
 *
 * The slot interval is constant, but ambient OS delivery is movement-driven so iOS can power down
 * Core Location while stationary. Battery may move {@link normalAccuracy} →
 * {@link lowBatteryAccuracy} or, below {@link suspendBelowLevel}, stop sampling entirely.
 */
export interface SamplingConfig {
  /** The fixed cadence. User-selectable; see `loadShareIntervalMs` in `../persistence.ts`. */
  intervalMs: number;
  /** Ambient OS movement filter in metres. */
  ambientDistanceM: number;
  /** Ambient iOS TaskManager delivery batching window in ms. */
  ambientDeliveryIntervalMs: number;
  /**
   * Accuracy tier at normal battery.
   */
  normalAccuracy: AccuracyTier;
  /** Accuracy tier under low battery / Low-Power Mode. */
  lowBatteryAccuracy: AccuracyTier;
  /** Battery level (0..1) at or below which we degrade to {@link lowBatteryAccuracy}. */
  lowBatteryThreshold: number;
  /** Battery level (0..1) below which we stop sampling entirely. */
  suspendBelowLevel: number;
  /**
   * Live-tracking cadence (ms). When live mode is on (a friend is actively watching), this
   * real-time interval replaces the fixed one — see {@link SamplingInputs.live}. This is the one
   * sanctioned exception to the constant-cadence rule above, and it IS observable as such: a
   * watcher of the wire can see live mode switch on. It must therefore stay explicitly
   * user-consented and bounded, never silently activated.
   */
  liveIntervalMs: number;
  /**
   * Minimum distance between fixes in live mode, as requested of the OS.
   *
   * Load-bearing on iOS and NOT sufficient on its own: `timeInterval` is Android-only, so on iOS
   * this is the ONLY gate Core Location applies. At the original 5 m a moving car crossed it several
   * times a second and live mode published at ~1 Hz — see {@link liveMinPublishMs}. The engine-side
   * gate is what actually bounds the rate; this only stops the OS waking us pointlessly often.
   */
  liveDistanceM: number;
  /** Accuracy tier in live mode. */
  liveAccuracy: AccuracyTier;
  /**
   * Hard floor between two live publishes (ms). Enforced by the engine, because it CANNOT be
   * enforced by the OS: `timeInterval` is ignored on iOS, so a purely OS-level cadence is a cadence
   * only Android honours. Without this, live mode's publish rate is set by how fast the user is
   * moving rather than by anything we chose.
   */
  liveMinPublishMs: number;
  /**
   * Minimum movement between two live publishes (m). Below this the fix is redundant — a friend
   * watching a map dot cannot see a 10 m correction — so publishing it burns battery, bandwidth and
   * trail history for nothing.
   */
  liveMinDistanceM: number;
  /**
   * Longest live-mode silence before we republish the last known position (ms). Without it, a
   * stationary phone in live mode is indistinguishable from a dead one — which is precisely the
   * ambiguity that made the original outage take hours to diagnose.
   */
  liveMaxQuietMs: number;
}

/** The concrete sampling parameters the engine hands to the OS location subsystem. */
export interface SamplingDecision {
  accuracy: AccuracyTier;
  timeIntervalMs: number;
  distanceIntervalM: number;
  /** iOS deferred-updates batching window (ms); 0 disables batching. */
  deferredUpdatesIntervalMs: number;
  /** False ⇒ stop sampling/publishing entirely (critically low battery). */
  active: boolean;
}
