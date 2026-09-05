import type { BatterySource } from './battery-source';
import { getTelemetry } from '@/features/dev/telemetry';
import type { EngineState } from './location-engine';
import type { AccuracyTier, SamplingDecision } from './types';

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

/**
 * What a cadence looks like to the thing being re-armed.
 *
 * Three fields, not a whole task config: the native runtime owns its own notification, providers
 * and background modes, so the only things a policy decision changes are how often we publish, how
 * far the phone must move before the OS bothers us, and which accuracy tier to ask for.
 */
export interface CadenceTarget {
  /** The publish slot the native gate enforces. */
  intervalMs: number;
  /** Distance filter. On iOS this is the only hardware-facing control — `timeInterval` is ignored. */
  distanceIntervalM: number;
  accuracy: AccuracyTier;
}

/** The provider seam: re-arm the running native runtime without re-requesting permission. */
export interface CadenceProvider {
  reprogram(cfg: CadenceTarget): Promise<void>;
}

/** The slice of the engine the controller observes. */
export interface CadenceEngine {
  onState(cb: (state: EngineState) => void): () => void;
  reevaluate(): Promise<unknown>;
}

export interface CadenceControllerOptions {
  engine: CadenceEngine;
  provider: CadenceProvider;
  battery: BatterySource;
  /** Caller-supplied start options that must remain fixed across policy-driven re-arms. */
  overrides?: Partial<CadenceTarget>;
  /** The cfg the OS was first armed with, so we don't redundantly re-arm on the first decision. */
  seed?: CadenceTarget;
  onError?(error: unknown): void;
}

export interface CadenceController {
  /** Begin observing; returns an async stop fn that waits for any in-flight OS re-arm. */
  start(): () => Promise<void>;
}

/**
 * Translate a sampling decision into what the native runtime needs.
 *
 * Much smaller than it was, because the runtime owns the rest. The notification text, the
 * foreground-service type, the background modes and the auto-pause flag are all its business now —
 * notably auto-pause, which is `false` there and was `true` here, and is what cost an iPhone
 * nineteen hours (see `BackgroundLocationRuntime.swift`).
 */
export function cfgFromDecision(decision: SamplingDecision): CadenceTarget {
  return {
    accuracy: decision.accuracy,
    intervalMs: decision.timeIntervalMs,
    distanceIntervalM: decision.distanceIntervalM,
  };
}

/** Whether two targets differ in anything worth re-arming for. */
export function cadenceDiffers(a: CadenceTarget, b: CadenceTarget): boolean {
  return (
    a.accuracy !== b.accuracy ||
    a.intervalMs !== b.intervalMs ||
    a.distanceIntervalM !== b.distanceIntervalM
  );
}

export function createCadenceController(opts: CadenceControllerOptions): CadenceController {
  const { engine, provider, battery, overrides, seed, onError } = opts;

  return {
    start(): () => Promise<void> {
      let armed: CadenceTarget | null = seed ?? null;
      let desired: CadenceTarget | null = seed ?? null;
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
                      'requested.interval_ms': target.intervalMs,
                      'requested.distance_m': target.distanceIntervalM,
                      'armed.interval_ms': armed?.intervalMs,
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
          ...cfgFromDecision(state.decision),
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
