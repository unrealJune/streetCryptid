import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import type { LocationFix } from '../../core/types';
import type { SamplingPolicy } from './sampling-policy';
import type { BatteryState, SamplingDecision } from './types';

/**
 * Report an engine failure that would otherwise only reach the UI.
 *
 * `setState({status:'error'})` is visible on the settings screen and nowhere else, so a
 * backgrounded phone whose ingest keeps throwing is indistinguishable from a perfectly healthy
 * idle one — and the background case is the only one that matters here.
 */
function reportEngineFailure(stage: string, message: string): void {
  getTelemetry()
    .startSpan('engine.failed', {
      attributes: {
        stage,
        'sc.drop_reason': `engine-${stage}-failed`,
        'exception.message': message,
      },
    })
    .end();
}

/**
 * The cadence driver, and the app-facing view of what the publish pipeline is doing.
 *
 * # What moved out of here
 *
 * This used to own the whole loop — the confidence gate, the wall-clock slot grid, a durable
 * outbox and the drain that emptied it. All four now live in Rust (`gate.rs`, `outbox.rs`,
 * `publish.rs`) so they can run in an OS callback with **no JS context alive**, which is the one
 * thing this file could never do: on 2026-08-29 a Pixel captured 446 real fixes over eleven and a
 * half hours while `expo-task-manager` spooled every one, because no headless JS context ever
 * started to hand them to.
 *
 * What is left is what genuinely belongs on this side: the sampling policy that programs the OS,
 * the state the settings screen renders, and the timer that asks for a heartbeat. Two copies of a
 * gate would drift; a driver and the thing it drives will not.
 *
 * # Why the decision still lives here
 *
 * {@link SamplingPolicy} decides accuracy tiers and the requested interval — how to program Core
 * Location and the Android provider. That is not duplicated in Rust and should not be: the native
 * side is told the interval and gates against it, but it has no business deciding what to ask the
 * OS for. `cadence-controller.ts` observes {@link LocationEngine.onState} to re-arm.
 */

/**
 * What a capture handed up by the native runtime should do to the engine.
 *
 * Split out from the service so the decision can be tested without standing up a background
 * session. It is small but it is not obvious: the two kinds go to different entry points, and the
 * position that comes back is the one the gate ACCEPTED, never the one that arrived. The gate
 * exists because a phone sometimes reports a position kilometres away, and rendering that before
 * discarding it throws the user's own marker across town for a frame.
 *
 * Returns the fix the caller should show as our own position, or `null` when this capture did not
 * establish one (a heartbeat, or a fix the gate refused with nothing accepted before it).
 */
export async function routeNativeCapture(
  event: { kind: 'fix' | 'heartbeat'; fix?: LocationFix },
  engine: Pick<LocationEngine, 'ingest' | 'heartbeat' | 'getState'>
): Promise<LocationFix | null> {
  if (event.kind === 'heartbeat' || !event.fix) {
    await engine.heartbeat();
    return null;
  }
  await engine.ingest(event.fix);
  return engine.getState().lastAcceptedFix;
}

/** What the engine needs from the native pipeline. One call per entry point, nothing else. */
export interface NativeDrain {
  /**
   * Run one captured fix through gate → outbox → seal → send. Resolves with what happened, which
   * is the only way this side learns whether the fix was accepted or why it was not.
   */
  ingest(fix: LocationFix, battery: BatteryState, intervalMs: number): Promise<DrainOutcome>;
  /**
   * Publish the slots that have come due with no new fix, reusing the last accepted position.
   * Also drains anything already queued, so it doubles as the flush.
   */
  heartbeat(battery: BatteryState, intervalMs: number): Promise<DrainOutcome>;
}

/** The subset of the native `IngestOutcome` this side acts on. */
export interface DrainOutcome {
  accepted: boolean;
  rejection: string | null;
  enqueued: number;
  published: number;
  pending: number;
  suspended: boolean;
}

export type EngineStatus = 'idle' | 'running' | 'paused' | 'error';

export interface EngineState {
  status: EngineStatus;
  /** When the last fix ARRIVED, accepted or not. Distinct from when one was last published. */
  lastFixAt: number | null;
  /** Latest position that passed the native confidence gate. */
  lastAcceptedFix: LocationFix | null;
  /** Why the last fix was refused, as the native gate spells it, or null when it was accepted. */
  lastRejection: string | null;
  decision: SamplingDecision | null;
  /** Fixes captured but not yet on the wire, as the native outbox reports it. */
  pending: number;
  error: string | null;
}

export interface LocationEngineOptions {
  drain: NativeDrain;
  policy: SamplingPolicy;
  /** Real device power; without it the policy assumes a perpetually full battery. */
  battery?: () => Promise<BatteryState>;
  /**
   * Called after a run that put envelopes on the wire.
   *
   * The native path writes our own fix to the iroh-docs replica, not to the app's trail store, so
   * the UI would not show our own dot until the next reconciliation. The service uses this to read
   * the replica back immediately — a local read, no network.
   */
  onPublished?: () => void;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

export interface LocationEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Hand one captured fix to the native pipeline. */
  ingest(fix: LocationFix, parent?: SpanContext): Promise<SamplingDecision>;
  /** Publish the slots that have come due without a new fix. Returns how many went out. */
  heartbeat(parent?: SpanContext): Promise<number>;
  /** Drain whatever is queued. The native heartbeat does both, so this is the same call. */
  flush(parent?: SpanContext): Promise<number>;
  /** Change the cadence the user chose. Re-decides so the controller re-arms the OS. */
  setIntervalMs(intervalMs: number): Promise<SamplingDecision>;
  /** Re-run the policy against current power, without a new fix. */
  reevaluate(): Promise<SamplingDecision>;
  onState(cb: (s: EngineState) => void): () => void;
  getState(): EngineState;
}

const DEFAULT_BATTERY: BatteryState = { level: 1, charging: false, lowPower: false };

export function createLocationEngine(opts: LocationEngineOptions): LocationEngine {
  const { drain, policy } = opts;
  const battery = opts.battery ?? (async (): Promise<BatteryState> => ({ ...DEFAULT_BATTERY }));
  const now = opts.now ?? Date.now;

  let state: EngineState = {
    status: 'idle',
    lastFixAt: null,
    lastAcceptedFix: null,
    lastRejection: null,
    decision: null,
    pending: 0,
    error: null,
  };
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

  function applyOutcome(outcome: DrainOutcome, fix: LocationFix | null): void {
    setState({
      pending: outcome.pending,
      error: null,
      ...(fix && outcome.accepted ? { lastAcceptedFix: fix, lastRejection: null } : {}),
      ...(fix && !outcome.accepted ? { lastRejection: outcome.rejection } : {}),
    });
    if (outcome.published > 0) opts.onPublished?.();
  }

  function fail(stage: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    reportEngineFailure(stage, message);
    setState({ status: 'error', error: message });
  }

  // Serialize: `ingest` and the foreground handler can both reach the native pipeline, and two
  // concurrent runs would each fill the same due slots. The native outbox is single-writer, so the
  // second would block on it anyway — coalescing here keeps the wait off the caller.
  let inFlight: Promise<DrainOutcome | null> | null = null;

  function exclusive(work: () => Promise<DrainOutcome | null>): Promise<DrainOutcome | null> {
    const run = (inFlight ?? Promise.resolve(null)).then(work, work);
    inFlight = run.then(
      () => null,
      () => null
    );
    return run;
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
      const batt = await battery();
      const decision = policy.decide({ battery: batt });
      setState({ decision, lastFixAt: now() });

      if (state.status !== 'running') {
        // Stamped rather than silent: "the engine was not running" and "the fix was refused" are
        // different faults and used to be indistinguishable from outside.
        //
        // `status` rides along because the two ways to be not-running are different bugs and read
        // identically without it. `error` means a drain threw and there is an `engine.failed` span
        // saying why; `idle` means nothing ever started this engine, or something stopped it and
        // left it wired up — which is a lifecycle race, has no accompanying span, and is what cost
        // a phone 102 consecutive captures on 2026-09-01 while every other attribute read healthy.
        getTelemetry()
          .startSpan('engine.ingest', {
            parent,
            attributes: { 'sc.drop_reason': 'engine-not-running', status: state.status },
          })
          .end();
        return decision;
      }

      const outcome = await exclusive(async () => {
        try {
          return await drain.ingest(fix, batt, policy.config.intervalMs);
        } catch (err) {
          fail('ingest', err);
          return null;
        }
      });
      if (outcome) applyOutcome(outcome, fix);
      return decision;
    },

    async heartbeat(parent?: SpanContext): Promise<number> {
      return runHeartbeat('heartbeat', parent);
    },

    async flush(parent?: SpanContext): Promise<number> {
      // The native heartbeat drains whatever is queued whether or not a slot came due, so a flush
      // and a heartbeat are the same call. Kept as two names because the callers mean different
      // things by them.
      return runHeartbeat('flush', parent);
    },

    async setIntervalMs(intervalMs: number): Promise<SamplingDecision> {
      policy.setIntervalMs(intervalMs);
      return this.reevaluate();
    },

    async reevaluate(): Promise<SamplingDecision> {
      const decision = policy.decide({ battery: await battery() });
      setState({ decision });
      return decision;
    },

    onState(cb: (s: EngineState) => void): () => void {
      listeners.add(cb);
      cb(getState());
      return () => listeners.delete(cb);
    },

    getState,
  };

  async function runHeartbeat(stage: string, _parent?: SpanContext): Promise<number> {
    if (state.status !== 'running') return 0;
    const batt = await battery();
    const outcome = await exclusive(async () => {
      try {
        return await drain.heartbeat(batt, policy.config.intervalMs);
      } catch (err) {
        fail(stage, err);
        return null;
      }
    });
    if (!outcome) return 0;
    applyOutcome(outcome, null);
    return outcome.published;
  }
}
