import {
  INITIAL_POST_READY,
  isStepLive,
  stepPostReady,
  type PostReadyEffect,
  type PostReadyEvent,
  type PostReadySteps,
  type StepOutcome,
} from '../post-ready-steps';

function play(...events: PostReadyEvent[]): { state: PostReadySteps; reports: PostReadyEffect[] } {
  let state = INITIAL_POST_READY;
  const reports: PostReadyEffect[] = [];
  for (const event of events) {
    const step = stepPostReady(state, event);
    state = step.state;
    reports.push(...step.effects);
  }
  return { state, reports };
}

const STEPS = ['profiles', 'stash-grant'] as const;
const start = (attempt = 1) => ({ type: 'start', attempt, steps: STEPS }) as const;
const settled = (step: string, outcome: 'ok' | 'error' = 'ok', attempt = 1) =>
  ({ type: 'settled', attempt, step, outcome }) as const;
const overrun = (step: string, attempt = 1) => ({ type: 'overrun', attempt, step }) as const;
const stop = { type: 'stop' } as const;
const outcomes = (reports: PostReadyEffect[]) => reports.map((r) => `${r.step}:${r.outcome}`);

describe('post-ready steps', () => {
  it('reports each step once when it finishes', () => {
    const { reports } = play(start(), settled('profiles'), settled('stash-grant', 'error'));
    expect(outcomes(reports)).toEqual(['profiles:ok', 'stash-grant:error']);
  });

  it('reports an overrun while the step is still running, then once more if it lands', () => {
    const { reports } = play(
      start(),
      overrun('profiles'),
      settled('profiles'),
      settled('profiles')
    );
    expect(outcomes(reports)).toEqual(['profiles:overrun', 'profiles:late']);
  });

  it('abandons what is still running at stop, and reports nothing after', () => {
    const { state, reports } = play(
      start(),
      settled('profiles'),
      stop,
      settled('stash-grant'),
      overrun('stash-grant')
    );
    expect(outcomes(reports)).toEqual(['profiles:ok', 'stash-grant:abandoned']);
    expect(isStepLive(state, 1)).toBe(false);
  });

  it('does not abandon a step that already overran, and drops its late landing after stop', () => {
    const { reports } = play(start(), overrun('profiles'), stop, settled('profiles'));
    expect(outcomes(reports)).toEqual(['profiles:overrun', 'stash-grant:abandoned']);
  });

  it('ignores completions for another attempt', () => {
    const { reports } = play(start(2), settled('profiles', 'ok', 1), overrun('profiles', 1));
    expect(reports).toEqual([]);
  });

  it('never starts again once stopped, nor for an older attempt', () => {
    expect(play(start(), stop, start(2)).state.attempt).toBe(1);
    expect(play(start(2), start(1)).state.attempt).toBe(2);
  });

  it('is live for its own attempt until stopped', () => {
    const { state } = play(start(3));
    expect(isStepLive(state, 3)).toBe(true);
    expect(isStepLive(state, 2)).toBe(false);
  });

  /**
   * Every sequence of up to six events against the reporting contract: per step, exactly one of
   * ok / error / overrun / abandoned, `late` only after an overrun and at most once, nothing at all
   * once stopped beyond the stop's own abandonments, and nothing for another attempt.
   */
  it('keeps its reporting contract across every short sequence of events', () => {
    const events = (state: PostReadySteps): PostReadyEvent[] => [
      start(state.attempt + 1),
      start(state.attempt),
      settled('profiles', 'ok', state.attempt),
      settled('profiles', 'error', state.attempt),
      settled('stash-grant', 'ok', state.attempt),
      settled('profiles', 'ok', state.attempt - 1),
      overrun('profiles', state.attempt),
      overrun('stash-grant', state.attempt),
      stop,
    ];
    const fail = (message: string): never => {
      throw new Error(message);
    };
    let sequences = 0;
    const walk = (
      state: PostReadySteps,
      ledger: ReadonlyMap<string, readonly StepOutcome[]>,
      depth: number,
      path: { toString(): string }
    ) => {
      if (depth === 0) return;
      for (const event of events(state)) {
        const { state: next, effects } = stepPostReady(state, event);
        sequences += 1;
        const here = { toString: () => `${String(path)} > ${JSON.stringify(event)}` };
        if (next === state && effects.length > 0) fail(`effects without a change: ${here}`);
        const seen = new Map(ledger);
        for (const effect of effects) {
          if (effect.attempt !== state.attempt && event.type !== 'start') {
            fail(`report for another attempt: ${here}`);
          }
          if (state.stopped) fail(`report after stop: ${here}`);
          if (effect.outcome === 'abandoned' && event.type !== 'stop') {
            fail(`abandoned outside stop: ${here}`);
          }
          const key = `${effect.attempt}:${effect.step}`;
          const prior = seen.get(key) ?? [];
          if (effect.outcome === 'late') {
            if (prior.join() !== 'overrun') fail(`late without a lone overrun: ${here}`);
          } else if (prior.length > 0) {
            fail(`second terminal report for ${key}: ${here}`);
          }
          seen.set(key, [...prior, effect.outcome]);
        }
        if (next.stopped && isStepLive(next, next.attempt)) fail(`live after stop: ${here}`);
        walk(next, seen, depth - 1, here);
      }
    };
    walk(INITIAL_POST_READY, new Map(), 6, 'start');
    // 9 + 9² + … + 9⁶: proof the walk ran, rather than vacuously passing.
    expect(sequences).toBe(9 + 81 + 729 + 6_561 + 59_049 + 531_441);
  });
});
