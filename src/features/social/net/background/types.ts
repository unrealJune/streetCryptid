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
 * The cadence is a **constant**, and that is a security property rather than a simplification.
 * Envelopes are E2E-encrypted, but the trail-stash and any network observer still see their
 * arrival times, and an interval that tracked motion (the old 18s driving / 45s walking / 180s
 * stationary ladder) published "what the user is doing" in the clear alongside the ciphertext.
 * Nothing here may vary with movement; battery may only move {@link normalAccuracy} →
 * {@link lowBatteryAccuracy} or, below {@link suspendBelowLevel}, stop sampling entirely — a hard
 * stop that reads as "the phone died", not as an activity class.
 */
export interface SamplingConfig {
  /** The fixed cadence. User-selectable; see `loadShareIntervalMs` in `../persistence.ts`. */
  intervalMs: number;
  /**
   * Accuracy tier at normal battery.
   *
   * There is deliberately no distance filter to pair with this: distance-gated delivery is
   * motion-gated delivery, so the OS would stop waking us the moment the user stopped moving —
   * re-opening at the platform layer exactly the leak this policy closes. Time is the only gate.
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
  /** Minimum distance between fixes in live mode. */
  liveDistanceM: number;
  /** Accuracy tier in live mode. */
  liveAccuracy: AccuracyTier;
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
