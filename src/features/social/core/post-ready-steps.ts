/**
 * The work a service starts once it is `ready` — profile reads, the stash grant, the first pairing
 * poll — as one explicit state machine.
 *
 * ## Why it is after `ready` at all
 *
 * These used to be `init()`'s `pairing` phase. On 2026-10-13 a Pixel 10 sat in that phase for 11+
 * minutes on a launch whose iroh DNS was failing outright, and because `ready` was behind it, the
 * map stayed on the positions it had loaded from disk: a friend who had pushed to that very phone
 * an hour earlier read "out of contact 4 hr". None of the four calls is needed for a working map.
 *
 * ## Why it needs rules
 *
 * Running after `ready` means running alongside everything else: user actions, the poll timer, a
 * shutdown. So:
 *
 * - every step ends in exactly one terminal report — `ok`, `error`, `overrun` (still running past
 *   its report bound, emitted while it is still running, because a step that never returns would
 *   otherwise never report at all), or `abandoned` (the service stopped under it);
 * - an `overrun` step that lands later reports once more, as `late`, with how long it took;
 * - after `stop`, nothing reports and {@link isStepLive} is false: a profile read that lands after
 *   shutdown must not apply, persist or emit;
 * - every completion carries its `attempt`, and one for another attempt changes nothing.
 *
 * Pure, so the rules are tests (`__tests__/post-ready-steps.test.ts`, which walks every short
 * event sequence against a reference model). The service executes the effects.
 */

export type StepStatus = 'running' | 'ok' | 'error' | 'overrun' | 'late' | 'abandoned';

/** The outcome a step reports. `running` never is. */
export type StepOutcome = Exclude<StepStatus, 'running'>;

export interface PostReadySteps {
  /** The attempt these steps belong to; 0 before any started. */
  readonly attempt: number;
  readonly stopped: boolean;
  readonly steps: Readonly<Record<string, StepStatus>>;
}

export type PostReadyEvent =
  | { readonly type: 'start'; readonly attempt: number; readonly steps: readonly string[] }
  | {
      readonly type: 'settled';
      readonly attempt: number;
      readonly step: string;
      readonly outcome: 'ok' | 'error';
    }
  | { readonly type: 'overrun'; readonly attempt: number; readonly step: string }
  | { readonly type: 'stop' };

export type PostReadyEffect = {
  readonly type: 'report';
  readonly attempt: number;
  readonly step: string;
  readonly outcome: StepOutcome;
};

export interface PostReadyStep {
  readonly state: PostReadySteps;
  readonly effects: readonly PostReadyEffect[];
}

export const INITIAL_POST_READY: PostReadySteps = Object.freeze({
  attempt: 0,
  stopped: false,
  steps: Object.freeze({}),
});

const NONE: readonly PostReadyEffect[] = Object.freeze([]);

function unchanged(state: PostReadySteps): PostReadyStep {
  return { state, effects: NONE };
}

export function stepPostReady(state: PostReadySteps, event: PostReadyEvent): PostReadyStep {
  switch (event.type) {
    case 'start': {
      // One service, one set: a service that has stopped never starts more, and an attempt never
      // starts twice or goes backwards.
      if (state.stopped || event.attempt <= state.attempt) return unchanged(state);
      const steps: Record<string, StepStatus> = {};
      for (const step of event.steps) steps[step] = 'running';
      return { state: { attempt: event.attempt, stopped: false, steps }, effects: NONE };
    }
    case 'settled': {
      if (event.attempt !== state.attempt || state.stopped) return unchanged(state);
      const status = state.steps[event.step];
      if (status === 'running') {
        return {
          state: { ...state, steps: { ...state.steps, [event.step]: event.outcome } },
          effects: [report(state.attempt, event.step, event.outcome)],
        };
      }
      if (status === 'overrun') {
        return {
          state: { ...state, steps: { ...state.steps, [event.step]: 'late' } },
          effects: [report(state.attempt, event.step, 'late')],
        };
      }
      return unchanged(state);
    }
    case 'overrun': {
      if (event.attempt !== state.attempt || state.stopped) return unchanged(state);
      if (state.steps[event.step] !== 'running') return unchanged(state);
      return {
        state: { ...state, steps: { ...state.steps, [event.step]: 'overrun' } },
        effects: [report(state.attempt, event.step, 'overrun')],
      };
    }
    case 'stop': {
      if (state.stopped) return unchanged(state);
      const steps: Record<string, StepStatus> = { ...state.steps };
      const effects: PostReadyEffect[] = [];
      for (const [step, status] of Object.entries(state.steps)) {
        if (status !== 'running') continue;
        steps[step] = 'abandoned';
        effects.push(report(state.attempt, step, 'abandoned'));
      }
      return { state: { ...state, stopped: true, steps }, effects };
    }
  }
}

/**
 * Whether a step's results may still be applied: it belongs to the current attempt and the
 * service has not stopped. An `overrun` step is still live — it is late, not wrong.
 */
export function isStepLive(state: PostReadySteps, attempt: number): boolean {
  return !state.stopped && attempt === state.attempt;
}

function report(attempt: number, step: string, outcome: StepOutcome): PostReadyEffect {
  return { type: 'report', attempt, step, outcome };
}
