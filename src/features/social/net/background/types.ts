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
  /**
   * Accuracy ceiling under low battery / Low-Power Mode. Applied as a *coarsening* clamp, so it
   * never re-tightens an already-cheaper tier chosen by the stationary branch.
   */
  lowBatteryAccuracy: AccuracyTier;
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
  /**
   * Drop to {@link SessionMode} `anchored` — location hardware fully idle behind a geofence — once
   * motion has been `stationary`. This is the single biggest battery lever on iOS, where the
   * time-based backoff never reaches the OS at all, but it changes background behaviour that has
   * historically been fragile, so it ships **off** until validated on a device. See
   * `anchor-controller.ts` for the state machine and how to turn it on.
   */
  anchorWhenStationary: boolean;
  /**
   * Radius (m) of the stationary anchor geofence. iOS will not reliably report an exit until the
   * device has moved ~200 m regardless of a smaller configured radius (a documented Core Location
   * behaviour), so anything below that buys nothing; 150 m keeps the *entry* boundary inside a
   * res-9 exploration hex (~350 m across) while staying realistic about the exit latency.
   */
  anchorRadiusM: number;
}

/**
 * How the OS location subsystem should be armed.
 *
 * - `continuous` — a running `startLocationUpdatesAsync` session delivering fixes.
 * - `anchored`   — the session is STOPPED and a single geofence sits at the last known position.
 *   The location hardware idles; leaving the geofence wakes us (even headless) and returns us to
 *   `continuous`. This is the pattern every battery-efficient tracker converges on (Foursquare's
 *   Movement SDK, transistorsoft's background-geolocation); see `cadence-controller.ts`.
 */
export type SessionMode = 'continuous' | 'anchored';

/** The concrete sampling parameters the engine hands to the OS location subsystem. */
export interface SamplingDecision {
  accuracy: AccuracyTier;
  /**
   * ⚠️ **ANDROID ONLY.** expo-location's `timeInterval` is not forwarded to Core Location — the iOS
   * `LocationOptions` record carries only `accuracy` and `distanceInterval`, so every cadence this
   * policy computes is silently discarded on iOS. Do not add battery logic that relies on this
   * field alone taking effect; on iOS the levers that actually reach the OS are {@link accuracy},
   * {@link distanceIntervalM} (a delivery filter, NOT a hardware duty-cycle) and, decisively,
   * {@link sessionMode}.
   */
  timeIntervalMs: number;
  distanceIntervalM: number;
  /**
   * Batching window (ms); 0 disables. NOTE: despite the name this is not Core Location's deferred
   * updates (Apple deprecated `allowDeferredLocationUpdates` in iOS 13). expo-location implements
   * it in userland by buffering callbacks, so it saves JS/CPU wakeups — not radio.
   */
  deferredUpdatesIntervalMs: number;
  /** False ⇒ skip sampling/publishing this tick (e.g. stationary + critically low battery). */
  active: boolean;
  /** Whether to run a continuous session or idle behind a stationary geofence. */
  sessionMode: SessionMode;
  /** Radius (m) of the stationary anchor geofence when {@link sessionMode} is `anchored`. */
  anchorRadiusM: number;
}
