/**
 * Shared types for the background location subsystem — the phone service that samples GPS
 * (foreground and background) and feeds fixes into the native drain, which writes the docs slot.
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
  /** The fixed cadence, `SHARE_INTERVAL_MS`. Overridable only for tests and the dev benchmark. */
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
