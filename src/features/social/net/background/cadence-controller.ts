import type { BatterySource } from './battery-source';
import type { BackgroundStartConfig } from './background-task';
import type { EngineState } from './location-engine';
import type { ActivityKind, MotionState, SamplingDecision } from './types';

/**
 * Bridges the engine's sampling decisions to the OS location task. Without it, the engine computes
 * a fresh decision on every fix but nothing ever re-programs the GPS hardware, so the phone stays
 * pinned at the cadence it was first armed with — the "background too active" bug. See
 * docs/social/ARCHITECTURE.md §9.
 *
 * Responsibilities:
 *  - On each engine decision, re-arm the OS task **only when the cadence materially changes**
 *    (accuracy, interval, distance, deferred window, iOS activity/auto-pause) — never on pending or
 *    status churn — so a stationary phone drops to the backed-off cadence and a moving/driving one
 *    tightens, instead of holding high-accuracy 15s sampling forever.
 *  - On a power event (Low-Power Mode toggled, charger un/plugged, level change) ask the engine to
 *    {@link CadenceEngine.reevaluate} immediately, so battery-saver backoff doesn't wait for the
 *    next fix (which, when stationary, may never come).
 *
 * Re-programs are serialized latest-wins: overlapping decisions collapse to the newest target so
 * two `startLocationUpdatesAsync` calls never race the same OS task.
 */

/** The provider seam: re-arm the running OS task without re-requesting permission. */
export interface CadenceProvider {
  reprogram(cfg: BackgroundStartConfig): Promise<void>;
  /** Stop OS location updates entirely — the `anchored` half of the state machine. */
  stopBackground(): Promise<void>;
}

/** The stationary-anchor seam, so the controller can be unit-tested without expo-location. */
export interface AnchorGeofenceSeam {
  arm(lat: number, lon: number, radiusM: number): Promise<void>;
  disarm(): Promise<void>;
}

/** The slice of the engine the controller observes. */
export interface CadenceEngine {
  onState(cb: (state: EngineState) => void): () => void;
  reevaluate(): Promise<unknown>;
  setMotion(motion: MotionState): Promise<unknown>;
}

/** Foreground-service notification carried through every re-arm (unchanged by cadence). */
export interface CadenceNotification {
  title: string;
  body: string;
  color?: string;
}

export interface CadenceControllerOptions {
  engine: CadenceEngine;
  provider: CadenceProvider;
  battery: BatterySource;
  notification: CadenceNotification;
  /** Caller-supplied start options that must remain fixed across policy-driven re-arms. */
  overrides?: Partial<BackgroundStartConfig>;
  /** The cfg the OS was first armed with, so we don't redundantly re-arm on the first decision. */
  seed?: BackgroundStartConfig;
  /**
   * The stationary-anchor geofence. Omit to disable anchoring entirely — the controller then only
   * ever drives `continuous` targets, exactly as before this seam existed.
   */
  anchor?: AnchorGeofenceSeam;
  /** Optional motion source to stop while anchored (it is foreground-only and costs nothing idle). */
  onError?(error: unknown): void;
}

export interface CadenceController {
  /** Begin observing; returns an async stop fn that waits for any in-flight OS re-arm. */
  start(): () => Promise<void>;
  /**
   * Hand back control after a stationary-anchor geofence exit. Tells the engine the device moved
   * (a bare `reevaluate` would re-read `stationary` and immediately re-anchor) and lets the normal
   * decision flow restore continuous sampling.
   */
  onAnchorExit(): Promise<void>;
}

/**
 * The controller's target state — a superset of the old "just a cfg", so anchoring and cadence
 * re-arms share ONE serialized queue. Two independent controllers racing `startLocationUpdatesAsync`
 * / `stopLocationUpdatesAsync` against the same OS task is exactly the hazard the latest-wins loop
 * below exists to prevent.
 */
type CadenceTarget =
  | { mode: 'continuous'; cfg: BackgroundStartConfig }
  | { mode: 'anchored'; lat: number; lon: number; radiusM: number };

/**
 * How far the anchor centre may drift before we re-arm the geofence. A stationary phone still
 * reports jittery fixes (tens of metres indoors); re-arming on each would defeat the point.
 */
const ANCHOR_DRIFT_TOLERANCE_M = 25;

/** Whether two targets differ enough to warrant touching the OS. */
export function targetDiffers(a: CadenceTarget, b: CadenceTarget): boolean {
  if (a.mode !== b.mode) return true;
  if (a.mode === 'continuous' && b.mode === 'continuous') return cadenceDiffers(a.cfg, b.cfg);
  if (a.mode === 'anchored' && b.mode === 'anchored') {
    if (a.radiusM !== b.radiusM) return true;
    return metresBetween(a.lat, a.lon, b.lat, b.lon) > ANCHOR_DRIFT_TOLERANCE_M;
  }
  return false;
}

/** Great-circle distance in metres. Local copy so this module stays dependency-free. */
function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** iOS activity hint for a motion class — lets Core Location pace + auto-pause appropriately. */
export function activityForMotion(motion: MotionState): ActivityKind {
  switch (motion) {
    case 'walking':
      return 'fitness';
    case 'driving':
      return 'automotive';
    case 'stationary':
    case 'unknown':
      return 'other';
  }
}

/** Translate a sampling decision + motion into a full OS re-arm config. */
export function cfgFromDecision(
  decision: SamplingDecision,
  motion: MotionState,
  notification: CadenceNotification
): BackgroundStartConfig {
  return {
    accuracy: decision.accuracy,
    timeIntervalMs: decision.timeIntervalMs,
    distanceIntervalM: decision.distanceIntervalM,
    deferredUpdatesIntervalMs: decision.deferredUpdatesIntervalMs,
    activityType: activityForMotion(motion),
    // Never let iOS Core Location auto-pause. It suspends background updates when it decides the
    // device is stationary and does NOT reliably resume, silently stopping background location
    // sharing until the app is next foregrounded (the "pings only arrive when the app is opened"
    // bug). Continuous sharing needs a steady stream; battery is bounded by the time/distance
    // cadence above, not by auto-pause.
    pausesUpdatesAutomatically: false,
    notificationTitle: notification.title,
    notificationBody: notification.body,
    ...(notification.color ? { notificationColor: notification.color } : {}),
  };
}

/** Whether two configs differ in any cadence-relevant field (notification text is ignored). */
export function cadenceDiffers(a: BackgroundStartConfig, b: BackgroundStartConfig): boolean {
  return (
    a.accuracy !== b.accuracy ||
    a.timeIntervalMs !== b.timeIntervalMs ||
    a.distanceIntervalM !== b.distanceIntervalM ||
    (a.deferredUpdatesIntervalMs ?? 0) !== (b.deferredUpdatesIntervalMs ?? 0) ||
    (a.activityType ?? 'other') !== (b.activityType ?? 'other') ||
    (a.pausesUpdatesAutomatically ?? false) !== (b.pausesUpdatesAutomatically ?? false)
  );
}

export function createCadenceController(opts: CadenceControllerOptions): CadenceController {
  const { engine, provider, battery, notification, overrides, seed, anchor, onError } = opts;

  let stopped = false;

  /**
   * Apply one target to the OS. Ordering in each transition is chosen so a partial failure leaves
   * us over-sampling rather than blind — being stuck at full cadence wastes battery, being stuck
   * anchored with no geofence means location sharing silently dies until the app is reopened.
   */
  async function apply(target: CadenceTarget, from: CadenceTarget | null): Promise<void> {
    if (target.mode === 'continuous') {
      // Restore GPS FIRST, then drop the anchor. If the disarm fails we get at worst a spurious
      // exit event later (harmless — it only nudges the engine); if we disarmed first and the
      // re-arm failed, we would have neither a session nor a wake-up.
      await provider.reprogram(target.cfg);
      if (from?.mode === 'anchored' && anchor) await anchor.disarm();
      return;
    }

    if (!anchor) return; // anchoring disabled; nothing to do
    // Arm the wake-up BEFORE idling the hardware, so there is no window in which we are neither
    // sampling nor monitoring a region.
    await anchor.arm(target.lat, target.lon, target.radiusM);
    await provider.stopBackground();
  }

  return {
    async onAnchorExit(): Promise<void> {
      // The exit proves movement, but brings no fix. Assert motion directly so the next decision
      // is `continuous`; `reevaluate()` alone would re-read `stationary` and re-anchor us.
      await engine.setMotion('walking');
    },

    start(): () => Promise<void> {
      let armed: CadenceTarget | null = seed ? { mode: 'continuous', cfg: seed } : null;
      let desired: CadenceTarget | null = armed;
      let driving = false;
      let drivePromise: Promise<void> | null = null;

      // Serialize re-arms; always converge to the newest `desired`, collapsing intermediate targets.
      const drive = (): void => {
        if (driving || stopped) return;
        driving = true;
        drivePromise = (async () => {
          try {
            while (!stopped && desired && (!armed || targetDiffers(desired, armed))) {
              const target = desired;
              const from = armed;
              try {
                await apply(target, from);
                armed = target;
              } catch (error) {
                onError?.(error);
                break; // don't spin on a failing re-arm; the next decision reschedules
              }
            }
          } finally {
            driving = false;
          }
        })();
      };

      const offState = engine.onState((state) => {
        if (!state.decision) return;
        // Anchoring needs a position to anchor AT. Without a fix yet, stay continuous — that is
        // also the startup path, where `motion` is `unknown` and anchoring would be wrong anyway.
        if (state.decision.sessionMode === 'anchored' && anchor && state.lastFix) {
          desired = {
            mode: 'anchored',
            lat: state.lastFix.lat,
            lon: state.lastFix.lon,
            radiusM: state.decision.anchorRadiusM,
          };
        } else {
          desired = {
            mode: 'continuous',
            cfg: { ...cfgFromDecision(state.decision, state.motion, notification), ...overrides },
          };
        }
        drive();
      });

      const offBattery = battery.subscribe(() => {
        void Promise.resolve(engine.reevaluate()).catch((error: unknown) => onError?.(error));
      });

      return async () => {
        stopped = true;
        desired = null;
        offState();
        offBattery();
        await drivePromise;
        // Never leave a geofence monitoring the user after sharing stops.
        if (anchor) await anchor.disarm().catch((error: unknown) => onError?.(error));
      };
    },
  };
}
