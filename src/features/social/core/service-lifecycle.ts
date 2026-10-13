/**
 * Where the location-sharing service is in starting up, as one explicit state machine.
 *
 * Startup used to be three loose module-scope variables in `use-location-sharing.tsx` — the init
 * promise, a "timed out" flag, and (from 2026-10-03) a "failed" one — each read by a different
 * effect with its own idea of what the combination meant. Every outage on this path was a
 * combination nobody had written down:
 *
 * - 2026-09-18: the init promise never settled, and nothing bounded the wait. Fixed with a
 *   watchdog and a "timed out" flag.
 * - 2026-10-03: the init promise REJECTED, which cleared the latch "so a later mount can retry" —
 *   but the provider never remounts, so nothing retried, and a Pixel 10 spent 13.7 hours with a
 *   map drawn from disk and pairing answering "NOTHING FOUND".
 * - A watchdog that fired before an init that then landed left the service ready and the UI
 *   believing it was not, until the next foreground discarded a perfectly good service.
 * - 2026-10-13: the watchdog's timer did not run while an Android app was in the background, so a
 *   foreground 11 minutes into a hung init declined to retry, and the timer then fired with
 *   nobody left to act on it.
 *
 * So the states are named, every transition is a pure function of the state and one event, and
 * the rules are tests (`__tests__/service-lifecycle.test.ts`, which also walks every short event
 * sequence against a reference model). The supervisor owns the side effects; this decides what
 * they are and emits each one exactly once, as data ({@link ServiceLifecycleEffect}).
 *
 * Every completion carries the `attempt` it belongs to, and one that does not match the current
 * attempt is ignored: a discarded attempt finishing late must not overwrite the one that replaced
 * it. (The work a service starts once ready is the service's own, and stops with it: see
 * `post-ready-steps.ts` and `pairing-poll-driver.ts`.)
 */

export type ServicePhase =
  /** Nothing in flight: before the first attempt, or just after one was discarded. */
  | 'idle'
  /** An init attempt is in flight and inside the watchdog. */
  | 'initializing'
  /** The service is up. Terminal for the process unless something discards it. */
  | 'ready'
  /** The last attempt rejected. Retryable. */
  | 'failed'
  /** The last attempt outlived the watchdog. It may still land; retryable meanwhile. */
  | 'stalled';

export interface ServiceLifecycle {
  readonly phase: ServicePhase;
  /** How many init attempts have begun in this process. */
  readonly attempt: number;
  /** Why the last attempt did not reach `ready`, when it failed. */
  readonly error: string | null;
  /** The `init()` step the last attempt was in when it stalled or failed. */
  readonly initPhase: string | null;
  /**
   * When the current attempt's `init()` itself started (epoch ms), or null before it has — the
   * permission prompts in front of it are a human's to sit on and never count. The watchdog is
   * judged against this by the wall clock on a foreground, as well as by its own timer.
   */
  readonly initStartedAt: number | null;
}

export type StallTrigger = 'watchdog' | 'foreground';

export type ServiceLifecycleEvent =
  /** The supervisor starts an init attempt. */
  | { readonly type: 'begin' }
  /** The attempt's `init()` itself has started. */
  | { readonly type: 'initStarted'; readonly attempt: number; readonly at: number }
  | { readonly type: 'ready'; readonly attempt: number }
  | {
      readonly type: 'failed';
      readonly attempt: number;
      readonly error: string;
      readonly initPhase: string | null;
    }
  /** The watchdog's own timer fired. */
  | { readonly type: 'watchdog'; readonly attempt: number; readonly initPhase: string | null }
  /** The app came to the foreground. */
  | {
      readonly type: 'foreground';
      readonly now: number;
      readonly watchdogMs: number;
      readonly initPhase: string | null;
    }
  /** Someone pressed retry. */
  | { readonly type: 'retry' };

/** What the supervisor must do because of a transition. */
export type ServiceLifecycleEffect =
  /** Say the attempt stalled (`app.init.timeout`). At most once per attempt. */
  | {
      readonly type: 'reportStall';
      readonly attempt: number;
      readonly trigger: StallTrigger;
      readonly initPhase: string | null;
    }
  /** Discard the service and begin a fresh attempt. */
  | { readonly type: 'discard'; readonly attempt: number; readonly trigger: 'foreground' | 'user' };

export interface ServiceLifecycleStep {
  readonly state: ServiceLifecycle;
  readonly effects: readonly ServiceLifecycleEffect[];
}

export const INITIAL_SERVICE_LIFECYCLE: ServiceLifecycle = Object.freeze({
  phase: 'idle',
  attempt: 0,
  error: null,
  initPhase: null,
  initStartedAt: null,
});

const NO_EFFECTS: readonly ServiceLifecycleEffect[] = Object.freeze([]);

function unchanged(state: ServiceLifecycle): ServiceLifecycleStep {
  return { state, effects: NO_EFFECTS };
}

/**
 * The next state and what it obliges the supervisor to do. Returns the SAME state object, and no
 * effects, when the event changes nothing — so a no-op is identifiable by identity.
 */
export function stepServiceLifecycle(
  state: ServiceLifecycle,
  event: ServiceLifecycleEvent
): ServiceLifecycleStep {
  switch (event.type) {
    case 'begin':
      // One attempt at a time, and a ready service is not restarted by asking again.
      if (state.phase === 'initializing' || state.phase === 'ready') return unchanged(state);
      return {
        state: {
          phase: 'initializing',
          attempt: state.attempt + 1,
          error: null,
          initPhase: null,
          initStartedAt: null,
        },
        effects: NO_EFFECTS,
      };
    case 'initStarted':
      if (event.attempt !== state.attempt || state.phase !== 'initializing') {
        return unchanged(state);
      }
      if (state.initStartedAt !== null) return unchanged(state);
      return { state: { ...state, initStartedAt: event.at }, effects: NO_EFFECTS };
    case 'ready':
      if (event.attempt !== state.attempt) return unchanged(state);
      // `stalled` included: an init that outlived the watchdog and then landed is a working
      // service, and treating it as broken until the next foreground is the third bug above.
      if (state.phase !== 'initializing' && state.phase !== 'stalled') return unchanged(state);
      return {
        state: { ...state, phase: 'ready', error: null, initPhase: null },
        effects: NO_EFFECTS,
      };
    case 'failed':
      if (event.attempt !== state.attempt) return unchanged(state);
      if (state.phase !== 'initializing' && state.phase !== 'stalled') return unchanged(state);
      return {
        state: { ...state, phase: 'failed', error: event.error, initPhase: event.initPhase },
        effects: NO_EFFECTS,
      };
    case 'watchdog':
      if (event.attempt !== state.attempt || state.phase !== 'initializing') {
        return unchanged(state);
      }
      return {
        state: { ...state, phase: 'stalled', initPhase: event.initPhase },
        effects: [
          {
            type: 'reportStall',
            attempt: state.attempt,
            trigger: 'watchdog',
            initPhase: event.initPhase,
          },
        ],
      };
    case 'foreground': {
      if (canRetryService(state)) {
        return {
          state: discarded(state),
          effects: [{ type: 'discard', attempt: state.attempt, trigger: 'foreground' }],
        };
      }
      const overdue =
        state.phase === 'initializing' &&
        state.initStartedAt !== null &&
        event.now - state.initStartedAt >= event.watchdogMs;
      if (!overdue) return unchanged(state);
      return {
        state: discarded(state),
        effects: [
          {
            type: 'reportStall',
            attempt: state.attempt,
            trigger: 'foreground',
            initPhase: event.initPhase,
          },
          { type: 'discard', attempt: state.attempt, trigger: 'foreground' },
        ],
      };
    }
    case 'retry':
      if (!canRetryService(state)) return unchanged(state);
      return {
        state: discarded(state),
        effects: [{ type: 'discard', attempt: state.attempt, trigger: 'user' }],
      };
  }
}

/**
 * The state after a discard: nothing in flight, and the abandoned attempt's number kept, so that
 * attempt landing late — `ready` or `failed` — matches nothing and changes nothing. The next
 * attempt is the supervisor's `begin`. Without this, an old init landing in the moment between the
 * discard and that `begin` would mark the process ready on a service nobody holds any more.
 */
function discarded(state: ServiceLifecycle): ServiceLifecycle {
  return { ...state, phase: 'idle', initStartedAt: null };
}

/** {@link stepServiceLifecycle} without its effects, for callers that only need the state. */
export function reduceServiceLifecycle(
  state: ServiceLifecycle,
  event: ServiceLifecycleEvent
): ServiceLifecycle {
  return stepServiceLifecycle(state, event).state;
}

/**
 * Whether the service should be discarded and started again — on a foreground, or when someone
 * presses retry. Never while an attempt is legitimately in flight inside its watchdog (a slow node
 * build, an unanswered permission prompt), or the retry would restart a healthy launch out from
 * under itself.
 */
export function canRetryService(state: ServiceLifecycle): boolean {
  return state.phase === 'failed' || state.phase === 'stalled';
}

/** Whether the service can be used: pairing, publishing, anything that needs the node. */
export function isServiceReady(state: ServiceLifecycle): boolean {
  return state.phase === 'ready';
}
