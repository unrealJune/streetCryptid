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
 *
 * So the states are named, every transition is a pure function of the state and one event, and
 * the rules are tests (`__tests__/service-lifecycle.test.ts`). The provider owns the side effects;
 * this decides what they are allowed to be.
 *
 * Every completion carries the `attempt` it belongs to, and one that does not match the current
 * attempt is ignored: a discarded attempt finishing late must not overwrite the one that replaced
 * it.
 */

export type ServicePhase =
  /** Nothing has started. */
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
}

export type ServiceLifecycleEvent =
  /** The provider starts an init attempt. */
  | { readonly type: 'begin' }
  | { readonly type: 'ready'; readonly attempt: number }
  | {
      readonly type: 'failed';
      readonly attempt: number;
      readonly error: string;
      readonly initPhase: string | null;
    }
  | { readonly type: 'watchdog'; readonly attempt: number; readonly initPhase: string | null };

export const INITIAL_SERVICE_LIFECYCLE: ServiceLifecycle = Object.freeze({
  phase: 'idle',
  attempt: 0,
  error: null,
  initPhase: null,
});

/**
 * The next state. Returns the SAME object when the event changes nothing, so a caller can tell a
 * no-op from a transition by identity.
 */
export function reduceServiceLifecycle(
  state: ServiceLifecycle,
  event: ServiceLifecycleEvent
): ServiceLifecycle {
  switch (event.type) {
    case 'begin':
      // One attempt at a time, and a ready service is not restarted by asking again.
      if (state.phase === 'initializing' || state.phase === 'ready') return state;
      return { phase: 'initializing', attempt: state.attempt + 1, error: null, initPhase: null };
    case 'ready':
      if (event.attempt !== state.attempt) return state;
      // `stalled` included: an init that outlived the watchdog and then landed is a working
      // service, and treating it as broken until the next foreground is the third bug above.
      if (state.phase !== 'initializing' && state.phase !== 'stalled') return state;
      return { ...state, phase: 'ready', error: null, initPhase: null };
    case 'failed':
      if (event.attempt !== state.attempt) return state;
      if (state.phase !== 'initializing' && state.phase !== 'stalled') return state;
      return { ...state, phase: 'failed', error: event.error, initPhase: event.initPhase };
    case 'watchdog':
      if (event.attempt !== state.attempt || state.phase !== 'initializing') return state;
      return { ...state, phase: 'stalled', initPhase: event.initPhase };
  }
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
