/**
 * Shared types for the background location subsystem — the phone service that samples GPS
 * (foreground and background) and feeds fixes into the live (gossip) + durable (docs) paths.
 * See docs/social/ARCHITECTURE.md §9. These types are deliberately native-free so the policy
 * and engine logic stay unit-testable without expo-location / expo-battery.
 */

/** Coarse movement class derived from successive fixes; drives cadence + accuracy. */
export type MotionState = 'stationary' | 'walking' | 'driving' | 'unknown';

/** A snapshot of device power, injected so the policy stays pure/testable. */
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

/** Tunables for {@link SamplingPolicy}; all durations in ms, distances in metres. */
export interface SamplingConfig {
  /** Cadence when moving normally. */
  baseIntervalMs: number;
  /** Minimum distance between fixes when moving. */
  baseDistanceM: number;
  /** Interval multiplier while stationary (back off to save battery). */
  stationaryMultiplier: number;
  /** Interval multiplier while driving (tighten so the trail isn't too coarse). */
  drivingMultiplier: number;
  /** Interval multiplier under low battery / low-power. */
  lowBatteryMultiplier: number;
  /** Battery level (0..1) at or below which we apply {@link lowBatteryMultiplier}. */
  lowBatteryThreshold: number;
  /** Never sample slower than this. */
  maxIntervalMs: number;
  /** Accuracy tier while walking / moving normally. */
  movingAccuracy: AccuracyTier;
  /** Accuracy tier while driving — kept high so a fast-moving trail stays road-accurate. */
  drivingAccuracy: AccuracyTier;
  /** Accuracy tier while stationary / conserving. */
  restingAccuracy: AccuracyTier;
  /** Battery level (0..1) below which we stop sampling entirely when also stationary. */
  suspendBelowLevel: number;
  /**
   * Live-tracking cadence (ms). When live mode is on (a friend is actively watching), this
   * real-time interval replaces the motion/battery-derived one — see {@link SamplingInputs.live}.
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
  /** False ⇒ skip sampling/publishing this tick (e.g. stationary + critically low battery). */
  active: boolean;
}
