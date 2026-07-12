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
}

/** The slice of the engine the controller observes. */
export interface CadenceEngine {
  onState(cb: (state: EngineState) => void): () => void;
  reevaluate(): Promise<unknown>;
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
  onError?(error: unknown): void;
}

export interface CadenceController {
  /** Begin observing; returns an async stop fn that waits for any in-flight OS re-arm. */
  start(): () => Promise<void>;
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
    pausesUpdatesAutomatically: true,
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
    (a.pausesUpdatesAutomatically ?? true) !== (b.pausesUpdatesAutomatically ?? true)
  );
}

export function createCadenceController(opts: CadenceControllerOptions): CadenceController {
  const { engine, provider, battery, notification, overrides, seed, onError } = opts;

  return {
    start(): () => Promise<void> {
      let armed: BackgroundStartConfig | null = seed ?? null;
      let desired: BackgroundStartConfig | null = seed ?? null;
      let driving = false;
      let stopped = false;
      let drivePromise: Promise<void> | null = null;

      // Serialize re-arms; always converge to the newest `desired`, collapsing intermediate targets.
      const drive = (): void => {
        if (driving || stopped) return;
        driving = true;
        drivePromise = (async () => {
          try {
            while (!stopped && desired && (!armed || cadenceDiffers(desired, armed))) {
              const target = desired;
              try {
                await provider.reprogram(target);
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
        const cfg = {
          ...cfgFromDecision(state.decision, state.motion, notification),
          ...overrides,
        };
        desired = cfg;
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
      };
    },
  };
}
