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
  publishFix(fix: LocationFix): Promise<number>;
  /** True once the node is bound and can publish. */
  isReady(): boolean;
}

export type EngineStatus = 'idle' | 'running' | 'paused' | 'error';

export interface EngineState {
  status: EngineStatus;
  /** ms epoch of the last fix we ingested, or null. */
  lastFixAt: number | null;
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
  ingest(fix: LocationFix): Promise<SamplingDecision>;
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
  /** Drain the outbox through the publisher (call on resume / node-ready / connectivity regained). */
  flush(): Promise<number>;
  onState(cb: (s: EngineState) => void): () => void;
  getState(): EngineState;
}

const DEFAULT_BATTERY: BatteryState = { level: 1, charging: false, lowPower: false };

export function createLocationEngine(opts: LocationEngineOptions): LocationEngine {
  const { publisher, outbox, trail, policy } = opts;
  const battery = opts.battery ?? (async (): Promise<BatteryState> => ({ ...DEFAULT_BATTERY }));
  const now = opts.now ?? Date.now;

  let state: EngineState = {
    status: 'idle',
    lastFixAt: null,
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

  function flush(): Promise<number> {
    if (flushing) return flushing;
    flushing = doFlush().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function doFlush(): Promise<number> {
    if (!publisher.isReady()) return 0;
    try {
      const n = await outbox.drain(async (fix) => {
        const seq = await publisher.publishFix(fix);
        await trail.appendOwn(fix, seq);
      });
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

    async ingest(fix: LocationFix): Promise<SamplingDecision> {
      const dtMs = lastFixAt === null ? 0 : now() - lastFixAt;
      const motion = deriveMotion(lastFix, fix, dtMs);
      const decision = policy.decide({ motion, battery: await battery(), live });

      lastFix = fix;
      lastFixAt = now();
      lastMotion = motion;

      if (state.status !== 'running') {
        setState({ decision, motion, lastFixAt });
        return decision;
      }

      setState({ decision, motion, lastFixAt });

      try {
        if (decision.active) {
          await outbox.enqueue(fix);
          if (publisher.isReady()) await flush();
        }
        const pending = await outbox.pending();
        setState({ pending });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: 'error', error: message });
      }

      return decision;
    },

    async reevaluate(): Promise<SamplingDecision> {
      const decision = policy.decide({ motion: lastMotion, battery: await battery(), live });
      setState({ decision, motion: lastMotion });
      return decision;
    },

    async setLiveMode(on: boolean): Promise<SamplingDecision> {
      live = on;
      const decision = policy.decide({ motion: lastMotion, battery: await battery(), live });
      setState({ decision, motion: lastMotion });
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
