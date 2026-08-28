import type { BatterySource } from './battery-source';
import type { BackgroundStartConfig } from './background-task';
import { getTelemetry } from '@/features/dev/telemetry';
import type { EngineState } from './location-engine';
import type { SamplingDecision } from './types';

/**
 * Bridges the engine's sampling decisions to the OS location task. Without it, the engine computes
 * a fresh decision on every fix but nothing ever re-programs the GPS hardware, so the phone stays
 * pinned at the cadence it was first armed with. See docs/social/ARCHITECTURE.md §9.
 *
 * Responsibilities:
 *  - On each engine decision, re-arm the OS task **only when the config materially changes**
 *    (accuracy, interval, distance, deferred window, iOS auto-pause) — never on pending or status
 *    churn. Now that the interval is fixed, in practice this fires for battery-driven accuracy
 *    changes and for a user-chosen interval change, not continuously.
 *  - On a power event (Low-Power Mode toggled, charger un/plugged, level change) ask the engine to
 *    {@link CadenceEngine.reevaluate} immediately, rather than waiting for the next fix.
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

/** Translate a sampling decision into a full OS re-arm config. */
export function cfgFromDecision(
  decision: SamplingDecision,
  notification: CadenceNotification
): BackgroundStartConfig {
  return {
    accuracy: decision.accuracy,
    timeIntervalMs: decision.timeIntervalMs,
    distanceIntervalM: decision.distanceIntervalM,
    deferredUpdatesIntervalMs: decision.deferredUpdatesIntervalMs,
    // Pinned to `other`. This used to track the motion class (fitness/automotive), which let Core
    // Location pace itself — but it is derived from movement, and we no longer classify movement at
    // all. A constant hint also keeps the OS request identical whatever the user is doing.
    activityType: 'other',
    // Apple recommends auto-pause for sustained background tracking. Expo also registers the
    // significant-change service, and our revive fence covers terminated-process recovery.
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
    (a.pausesUpdatesAutomatically ?? false) !== (b.pausesUpdatesAutomatically ?? false)
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
                // This is not a dropped fix, it is a WRONG CADENCE that persists: the OS keeps
                // delivering at whatever interval was last successfully armed, so a phone can look
                // perfectly healthy while sampling at a rate nobody chose. Nothing downstream can
                // infer it, which is why it gets its own span rather than only `onError`.
                getTelemetry()
                  .startSpan('cadence.rearm', {
                    attributes: {
                      'requested.interval_ms': target.timeIntervalMs,
                      'requested.distance_m': target.distanceIntervalM,
                      'armed.interval_ms': armed?.timeIntervalMs,
                      'armed.distance_m': armed?.distanceIntervalM,
                      'sc.drop_reason': 'cadence-rearm-failed',
                      'exception.message': error instanceof Error ? error.message : String(error),
                    },
                  })
                  .end();
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
          ...cfgFromDecision(state.decision, notification),
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
