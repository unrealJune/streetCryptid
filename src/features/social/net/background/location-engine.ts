import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';
import type { FixOutbox } from './fix-outbox';
import { deriveMotion, type SamplingPolicy } from './sampling-policy';
import type { TrailStore } from './trail-store';
import type { BatteryState, MotionState, SamplingDecision } from './types';

/**
 * The testable heart of the background service. It owns the loop:
 *
 *   fix (foreground watch OR background task)
 *     → deriveMotion + policy.decide  (gate/cadence)
 *     → if active: outbox.enqueue
 *     → if publisher.isReady: flush → for each: publisher.publishFix(fix) → trail.appendOwn(fix, seq)
 *
 * Trail append happens at *publish* time (not capture) so our own trail uses the same `seq` that
 * goes on the wire — keeping it consistent with what friends receive/backfill. Offline captures
 * wait in the outbox and get their seq + trail entry when they finally drain. See ARCHITECTURE §9.
 *
 * The engine takes only the minimal slice of {@link FixPublisher} it needs, so it can be unit-tested
 * with a fake publisher + ManualLocationProvider + in-memory outbox/trail + a fake clock — no native.
 */

/** The slice of LocationSharingService the engine depends on. */
export interface FixPublisher {
  /**
   * Seal + broadcast (gossip) + durable-write (docs) the fix; resolves with the seq assigned.
   * Must **throw** if it cannot publish (node not ready) rather than resolving a placeholder, so
   * `outbox.drain` stops and retains the fix instead of dropping it.
   */
  publishFix(fix: LocationFix, parent?: SpanContext): Promise<number>;
  /** True once the node is bound and can publish. */
  isReady(): boolean;
}

export type EngineStatus = 'idle' | 'running' | 'paused' | 'error';

export interface EngineState {
  status: EngineStatus;
  /** ms epoch of the last fix we ingested, or null. */
  lastFixAt: number | null;
  /**
   * The last fix ingested, or null. Carried on the state so the cadence controller can place the
   * stationary anchor geofence without keeping its own copy of the position.
   */
  lastFix: LocationFix | null;
  /** Last sampling decision applied (so the UI/provider can reflect cadence). */
  decision: SamplingDecision | null;
  /** Motion class of the last decision (drives the iOS activity hint). */
  motion: MotionState;
  /** Fixes waiting in the outbox. */
  pending: number;
  error: string | null;
}

export interface LocationEngineOptions {
  publisher: FixPublisher;
  outbox: FixOutbox;
  trail: TrailStore;
  policy: SamplingPolicy;
  /** Reads current battery; the policy backs off when low. Default: full battery, not low-power. */
  battery?: () => Promise<BatteryState>;
  /**
   * Reads the OS motion coprocessor's classification, or `null` for "no opinion". When it has an
   * opinion the engine trusts it over {@link deriveMotion}, which is derived from GPS displacement
   * and therefore cannot report `stationary` without first burning a fix to prove it. Returning
   * `null` (unavailable, stale, or low confidence) falls back to the GPS-derived value.
   * See `motion-source.ts` — notably, this is FOREGROUND-ONLY on both platforms.
   */
  motion?: () => MotionState | null;
  /** Injectable clock. Default `Date.now`. */
  now?: () => number;
}

export interface LocationEngine {
  /** Begin accepting fixes and publishing. Idempotent. */
  start(): Promise<void>;
  /** Stop accepting fixes; queued fixes remain in the outbox for the next start/flush. */
  stop(): Promise<void>;
  /**
   * Feed a fix from any source. Applies the policy gate, appends to the outbox, and (if the
   * publisher is ready) flushes. Returns the {@link SamplingDecision} used so the caller can
   * re-program the OS location cadence.
   */
  ingest(fix: LocationFix, parent?: SpanContext): Promise<SamplingDecision>;
  /**
   * Recompute the sampling decision from the last known motion and a *fresh* battery read, without
   * ingesting a new fix. Call this on a power event (Low Power Mode toggled, charger un/plugged) so
   * cadence backs off/tightens immediately instead of waiting for the next GPS fix. Emits state so a
   * cadence controller can re-program the OS. No-op enqueue: it never publishes.
   */
  reevaluate(): Promise<SamplingDecision>;
  /**
   * Turn real-time live tracking on/off (a friend is actively watching). While on, the policy uses
   * its real-time `live*` cadence regardless of motion. Recomputes + emits immediately so the
   * cadence controller re-programs the OS; returns the new decision.
   */
  setLiveMode(on: boolean): Promise<SamplingDecision>;
  /**
   * Force the engine's belief about motion and recompute. Used when something outside the fix
   * stream proves the device moved — specifically a stationary-anchor geofence exit, which arrives
   * with no accompanying fix and must NOT be answered by `reevaluate()` alone: that would re-read
   * the same `stationary` value and immediately re-anchor, stranding us. See `cadence-controller.ts`.
   */
  setMotion(motion: MotionState): Promise<SamplingDecision>;
  /** Drain the outbox through the publisher (call on resume / node-ready / connectivity regained). */
  flush(parent?: SpanContext): Promise<number>;
  onState(cb: (s: EngineState) => void): () => void;
  getState(): EngineState;
}

const DEFAULT_BATTERY: BatteryState = { level: 1, charging: false, lowPower: false };

export function createLocationEngine(opts: LocationEngineOptions): LocationEngine {
  const { publisher, outbox, trail, policy } = opts;
  const battery = opts.battery ?? (async (): Promise<BatteryState> => ({ ...DEFAULT_BATTERY }));
  const osMotion = opts.motion ?? ((): MotionState | null => null);
  const now = opts.now ?? Date.now;

  let state: EngineState = {
    status: 'idle',
    lastFixAt: null,
    lastFix: null,
    decision: null,
    motion: 'unknown',
    pending: 0,
    error: null,
  };

  let lastFix: LocationFix | null = null;
  let lastFixAt: number | null = null;
  let lastMotion: MotionState = 'unknown';
  let live = false;
  const listeners = new Set<(s: EngineState) => void>();

  function emit(): void {
    const snapshot = getState();
    for (const cb of listeners) cb(snapshot);
  }

  function setState(patch: Partial<EngineState>): void {
    state = { ...state, ...patch };
    emit();
  }

  function getState(): EngineState {
    return { ...state };
  }

  // Serialize flushes: ingest() and the lifecycle onForeground handler can both call flush().
  // Two concurrent drains would each load their own copy of the outbox and double-publish the
  // same fix (with different seqs), so coalesce overlapping calls onto one in-flight promise.
  let flushing: Promise<number> | null = null;

  function flush(parent?: SpanContext): Promise<number> {
    if (flushing) return flushing;
    flushing = doFlush(parent).finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function doFlush(parent?: SpanContext): Promise<number> {
    if (!publisher.isReady()) return 0;
    try {
      const n = await outbox.drain(async (fix, drainParent) => {
        const seq = await publisher.publishFix(fix, drainParent);
        await trail.appendOwn(fix, seq);
      }, parent);
      const pending = await outbox.pending();
      setState({ pending, error: null });
      return n;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let pending = state.pending;
      try {
        pending = await outbox.pending();
      } catch {
        // ignore secondary failure reading pending
      }
      setState({ status: 'error', error: message, pending });
      return 0;
    }
  }

  return {
    async start(): Promise<void> {
      if (state.status === 'running') return;
      setState({ status: 'running', error: null });
    },

    async stop(): Promise<void> {
      setState({ status: 'idle' });
    },

    async ingest(fix: LocationFix, parent?: SpanContext): Promise<SamplingDecision> {
      const dtMs = lastFixAt === null ? 0 : now() - lastFixAt;
      const gpsMotion = deriveMotion(lastFix, fix, dtMs);
      // Prefer the coprocessor: it can say "stationary" without spending a fix, which is what lets
      // the policy back off (and, with anchoring on, idle the hardware) instead of sampling forever
      // to re-confirm that nothing moved. Falls back to GPS-derived motion when it has no opinion.
      const fromOs = osMotion();
      const motion = fromOs ?? gpsMotion;
      const batt = await battery();
      const decision = policy.decide({ motion, battery: batt, live });

      // The policy gate is the FIRST place a captured fix can die; the span says which knob
      // (motion/battery/live) produced the decision and stamps a drop reason when it gated.
      const span = getTelemetry().startSpan('engine.ingest', {
        parent,
        attributes: {
          motion,
          'motion.source': fromOs === null ? 'gps' : 'coprocessor',
          'motion.gps': gpsMotion,
          live,
          'battery.level': Math.round(batt.level * 100) / 100,
          'battery.charging': batt.charging,
          'battery.low_power': batt.lowPower,
          'decision.active': decision.active,
          'decision.interval_ms': decision.timeIntervalMs,
          'decision.accuracy': decision.accuracy,
          'publisher.ready': publisher.isReady(),
        },
      });

      lastFix = fix;
      lastFixAt = now();
      lastMotion = motion;

      try {
        if (state.status !== 'running') {
          span.setAttribute('sc.drop_reason', 'engine-not-running');
          setState({ decision, motion, lastFixAt, lastFix: fix });
          return decision;
        }

        setState({ decision, motion, lastFixAt, lastFix: fix });

        try {
          if (decision.active) {
            await outbox.enqueue(fix, span.context);
            if (publisher.isReady()) await flush(span.context);
          } else {
            span.setAttribute('sc.drop_reason', 'sampling-suspended');
          }
          const pending = await outbox.pending();
          span.setAttribute('pending', pending);
          setState({ pending });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.recordError(err);
          setState({ status: 'error', error: message });
        }

        return decision;
      } finally {
        span.end();
      }
    },

    async reevaluate(): Promise<SamplingDecision> {
      // Re-read the coprocessor here, not just on ingest: this is the path a motion-change
      // notification takes, and it is the ONLY way a stationary→walking transition can retighten
      // cadence without a GPS fix — which is precisely the fix an anchored session cannot produce.
      const motion = osMotion() ?? lastMotion;
      lastMotion = motion;
      const decision = policy.decide({ motion, battery: await battery(), live });
      setState({ decision, motion });
      return decision;
    },

    async setMotion(motion: MotionState): Promise<SamplingDecision> {
      lastMotion = motion;
      const decision = policy.decide({ motion, battery: await battery(), live });
      setState({ decision, motion });
      return decision;
    },

    async setLiveMode(on: boolean): Promise<SamplingDecision> {
      live = on;
      const motion = osMotion() ?? lastMotion;
      lastMotion = motion;
      const decision = policy.decide({ motion, battery: await battery(), live });
      setState({ decision, motion });
      return decision;
    },

    flush,

    onState(cb: (s: EngineState) => void): () => void {
      listeners.add(cb);
      cb(getState());
      return () => {
        listeners.delete(cb);
      };
    },

    getState,
  };
}
