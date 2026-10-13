import {
  canRetryService,
  INITIAL_SERVICE_LIFECYCLE,
  isServiceReady,
  reduceServiceLifecycle,
  stepServiceLifecycle,
  type ServiceLifecycle,
  type ServiceLifecycleEffect,
  type ServiceLifecycleEvent,
  type ServicePhase,
} from '../service-lifecycle';

function run(...events: ServiceLifecycleEvent[]): ServiceLifecycle {
  return events.reduce(reduceServiceLifecycle, INITIAL_SERVICE_LIFECYCLE);
}

const begin = { type: 'begin' } as const;
const ready = (attempt: number) => ({ type: 'ready', attempt }) as const;
const failed = (
  attempt: number,
  error = 'claim refused',
  initPhase: string | null = 'native-start'
) => ({ type: 'failed', attempt, error, initPhase }) as const;
const watchdog = (attempt: number, initPhase: string | null = 'create-node') =>
  ({ type: 'watchdog', attempt, initPhase }) as const;

describe('service lifecycle', () => {
  it('starts idle and not ready', () => {
    expect(INITIAL_SERVICE_LIFECYCLE.phase).toBe('idle');
    expect(isServiceReady(INITIAL_SERVICE_LIFECYCLE)).toBe(false);
    expect(canRetryService(INITIAL_SERVICE_LIFECYCLE)).toBe(false);
  });

  it('runs the happy path: begin, then ready', () => {
    const state = run(begin, ready(1));
    expect(state).toEqual({
      phase: 'ready',
      attempt: 1,
      error: null,
      initPhase: null,
      initStartedAt: null,
    });
    expect(isServiceReady(state)).toBe(true);
  });

  /** The 2026-10-03 shape: a rejection must be RETRYABLE, not a dead end. */
  it('makes a rejected init retryable, and remembers why and where', () => {
    const state = run(begin, failed(1, 'AlreadyOpen', 'native-start'));
    expect(state.phase).toBe('failed');
    expect(state.error).toBe('AlreadyOpen');
    expect(state.initPhase).toBe('native-start');
    expect(canRetryService(state)).toBe(true);
    expect(isServiceReady(state)).toBe(false);
  });

  /** The 2026-09-18 shape: an init that never settles is retryable once the watchdog fires. */
  it('makes an init that outlives the watchdog retryable', () => {
    const state = run(begin, watchdog(1, 'create-node'));
    expect(state.phase).toBe('stalled');
    expect(state.initPhase).toBe('create-node');
    expect(canRetryService(state)).toBe(true);
  });

  it('accepts an init that lands after its watchdog fired', () => {
    // It used to be ignored: the service was up and the UI said it was not until a foreground.
    const state = run(begin, watchdog(1), ready(1));
    expect(state.phase).toBe('ready');
    expect(state.initPhase).toBeNull();
  });

  it('records a stalled init that finally rejects as failed', () => {
    expect(run(begin, watchdog(1), failed(1)).phase).toBe('failed');
  });

  it('never retries an attempt that is still inside its watchdog', () => {
    expect(canRetryService(run(begin))).toBe(false);
  });

  it('runs one attempt at a time', () => {
    const first = run(begin);
    expect(reduceServiceLifecycle(first, begin)).toBe(first);
  });

  it('does not restart a ready service', () => {
    const up = run(begin, ready(1));
    expect(reduceServiceLifecycle(up, begin)).toBe(up);
  });

  it('starts a NEW attempt on a retry, with a clean slate', () => {
    const state = run(begin, failed(1), begin);
    expect(state).toEqual({
      phase: 'initializing',
      attempt: 2,
      error: null,
      initPhase: null,
      initStartedAt: null,
    });
  });

  describe('a discarded attempt finishing late changes nothing', () => {
    it('ignores a late success from the attempt a retry replaced', () => {
      const retrying = run(begin, watchdog(1), begin);
      expect(reduceServiceLifecycle(retrying, ready(1))).toBe(retrying);
    });

    it('ignores a late failure from the attempt a retry replaced', () => {
      const retrying = run(begin, watchdog(1), begin);
      expect(reduceServiceLifecycle(retrying, failed(1))).toBe(retrying);
    });

    it('ignores a late watchdog from an earlier attempt', () => {
      const retrying = run(begin, failed(1), begin);
      expect(reduceServiceLifecycle(retrying, watchdog(1))).toBe(retrying);
    });

    it('lets a late failure not take down a service that came up in the meantime', () => {
      const up = run(begin, watchdog(1), begin, ready(2));
      expect(reduceServiceLifecycle(up, failed(1))).toBe(up);
    });
  });

  it('ignores completions that arrive with nothing in flight', () => {
    expect(reduceServiceLifecycle(INITIAL_SERVICE_LIFECYCLE, ready(0))).toBe(
      INITIAL_SERVICE_LIFECYCLE
    );
    const up = run(begin, ready(1));
    expect(reduceServiceLifecycle(up, failed(1))).toBe(up);
    expect(reduceServiceLifecycle(up, watchdog(1))).toBe(up);
  });

  /**
   * Every sequence of up to six events, against the invariants that matter to the screen:
   * the attempt count never goes backwards, `ready` is only reached through an attempt that
   * began, a retryable state is never one with an attempt in flight inside its watchdog, and a
   * reducer that returns a new object always changed something.
   */
  it('keeps its invariants across every short sequence of events', () => {
    const events = (attempt: number): ServiceLifecycleEvent[] => [
      begin,
      ready(attempt),
      ready(attempt - 1),
      failed(attempt),
      failed(attempt - 1),
      watchdog(attempt),
      watchdog(attempt - 1),
    ];
    const phases = new Set<ServicePhase>();
    let sequences = 0;
    const fail = (rule: string, event: ServiceLifecycleEvent): never => {
      throw new Error(`${rule}: ${JSON.stringify(event)}`);
    };
    const sameFields = (a: ServiceLifecycle, b: ServiceLifecycle) =>
      (Object.keys(a) as (keyof ServiceLifecycle)[]).every((key) => a[key] === b[key]);
    const walk = (state: ServiceLifecycle, depth: number) => {
      phases.add(state.phase);
      if (depth === 0) return;
      for (const event of events(state.attempt)) {
        const next = reduceServiceLifecycle(state, event);
        sequences += 1;
        // Plain checks, not `expect`, in the hot loop: a hundred thousand matcher calls is most of
        // a CI runner's test timeout.
        if (next.attempt < state.attempt) fail('attempt went backwards', event);
        if (next.phase === 'ready' && next.attempt <= 0) fail('ready with no attempt', event);
        if (next.phase === 'initializing' && canRetryService(next))
          fail('retryable in flight', event);
        if (next !== state && sameFields(next, state)) fail('new object, no change', event);
        if ((next.phase === 'ready' || next.phase === 'initializing') && next.error !== null) {
          fail('error kept', event);
        }
        walk(next, depth - 1);
      }
    };
    walk(INITIAL_SERVICE_LIFECYCLE, 6);
    expect(sequences).toBeGreaterThan(100_000);
    expect([...phases].sort()).toEqual(['failed', 'idle', 'initializing', 'ready', 'stalled']);
  });
});

describe('service lifecycle effects', () => {
  const WATCHDOG = 30_000;
  const initStarted = (attempt: number, at = 1_000) =>
    ({ type: 'initStarted', attempt, at }) as const;
  const foreground = (now: number, initPhase: string | null = 'pairing') =>
    ({ type: 'foreground', now, watchdogMs: WATCHDOG, initPhase }) as const;
  const retry = { type: 'retry' } as const;

  function effectsOf(...events: ServiceLifecycleEvent[]): ServiceLifecycleEffect[] {
    let state = INITIAL_SERVICE_LIFECYCLE;
    const effects: ServiceLifecycleEffect[] = [];
    for (const event of events) {
      const step = stepServiceLifecycle(state, event);
      state = step.state;
      effects.push(...step.effects);
    }
    return effects;
  }

  /** The 2026-10-13 Pixel: back 689 s into an init whose 30 s timer never ran. */
  it('stalls and discards an attempt the clock says is overdue, on a foreground', () => {
    const effects = effectsOf(begin, initStarted(1, 1_000), foreground(1_000 + 689_519));
    expect(effects).toEqual([
      { type: 'reportStall', attempt: 1, trigger: 'foreground', initPhase: 'pairing' },
      { type: 'discard', attempt: 1, trigger: 'foreground' },
    ]);
  });

  it('reports the stall once, whichever of the timer and the foreground sees it first', () => {
    const late = effectsOf(begin, initStarted(1), foreground(1_000 + WATCHDOG), watchdog(1));
    expect(late.filter((e) => e.type === 'reportStall')).toHaveLength(1);
    const early = effectsOf(begin, initStarted(1), watchdog(1), foreground(1_000 + WATCHDOG));
    expect(early.filter((e) => e.type === 'reportStall')).toEqual([
      { type: 'reportStall', attempt: 1, trigger: 'watchdog', initPhase: 'create-node' },
    ]);
    // The timer-first path still retries on that foreground.
    expect(early).toContainEqual({ type: 'discard', attempt: 1, trigger: 'foreground' });
  });

  it('leaves an attempt inside its watchdog alone on a foreground', () => {
    expect(effectsOf(begin, initStarted(1, 1_000), foreground(1_000 + WATCHDOG - 1))).toEqual([]);
  });

  it('never counts the permission prompts before init() against the watchdog', () => {
    // `initStarted` has not arrived: the human is still on a system prompt.
    expect(effectsOf(begin, foreground(10 * WATCHDOG))).toEqual([]);
  });

  it('retries a failed init on the next foreground', () => {
    expect(effectsOf(begin, failed(1), foreground(0))).toEqual([
      { type: 'discard', attempt: 1, trigger: 'foreground' },
    ]);
  });

  it('retries on request only when there is something to retry', () => {
    expect(effectsOf(begin, retry)).toEqual([]);
    expect(effectsOf(begin, ready(1), retry)).toEqual([]);
    expect(effectsOf(begin, failed(1), retry)).toEqual([
      { type: 'discard', attempt: 1, trigger: 'user' },
    ]);
  });

  it('keeps only the first initStarted of an attempt', () => {
    const state = run(begin, initStarted(1, 5), initStarted(1, 99));
    expect(state.initStartedAt).toBe(5);
  });

  /**
   * Every sequence of up to five events, with an effect ledger: the effects are the contract the
   * supervisor relies on, so each is checked against what a correct lifecycle must emit.
   */
  it('emits each effect only when it is owed, across every short sequence of events', () => {
    const events = (state: ServiceLifecycle): ServiceLifecycleEvent[] => [
      begin,
      initStarted(state.attempt),
      ready(state.attempt),
      ready(state.attempt - 1),
      failed(state.attempt),
      watchdog(state.attempt),
      watchdog(state.attempt - 1),
      foreground(1_000 + WATCHDOG - 1),
      foreground(1_000 + WATCHDOG),
      retry,
    ];
    interface Ledger {
      stallReports: Set<number>;
    }
    let sequences = 0;
    const fail = (rule: string, event: ServiceLifecycleEvent): never => {
      throw new Error(`${rule}: ${JSON.stringify(event)}`);
    };
    const walk = (state: ServiceLifecycle, ledger: Ledger, depth: number) => {
      if (depth === 0) return;
      for (const event of events(state)) {
        const { state: next, effects } = stepServiceLifecycle(state, event);
        sequences += 1;
        const seen: Ledger = { stallReports: new Set(ledger.stallReports) };
        if (next === state && effects.length > 0) fail('effects without a change', event);
        for (const effect of effects) {
          if (effect.attempt !== state.attempt) fail('effect for another attempt', event);
          switch (effect.type) {
            case 'reportStall':
              if (seen.stallReports.has(effect.attempt)) fail('stall reported twice', event);
              seen.stallReports.add(effect.attempt);
              break;
            case 'discard':
              // Only something retryable — or overdue by the clock — is ever discarded, never a
              // healthy launch; and afterwards nothing is in flight.
              if (
                !canRetryService(state) &&
                !(state.phase === 'initializing' && event.type === 'foreground')
              ) {
                fail('discarded a healthy launch', event);
              }
              if (next.phase !== 'idle' || next.attempt !== state.attempt) {
                fail('discard left something in flight', event);
              }
              break;
          }
        }
        // Ready only through the attempt in flight.
        if (
          next.phase === 'ready' &&
          state.phase !== 'ready' &&
          !(event.type === 'ready' && event.attempt === state.attempt)
        ) {
          fail('ready without its attempt', event);
        }
        walk(next, seen, depth - 1);
      }
    };
    walk(INITIAL_SERVICE_LIFECYCLE, { stallReports: new Set() }, 5);
    // 10 + 10² + … + 10⁵: proof the walk ran, rather than vacuously passing.
    expect(sequences).toBe(10 + 100 + 1_000 + 10_000 + 100_000);
  });

  /** The window between a discard and the next `begin`, where an old init can still land. */
  it('ignores the discarded attempt landing before the next one begins', () => {
    const discarded = run(begin, watchdog(1), retry);
    expect(discarded.phase).toBe('idle');
    expect(reduceServiceLifecycle(discarded, ready(1))).toBe(discarded);
    expect(reduceServiceLifecycle(discarded, failed(1))).toBe(discarded);
    expect(run(begin, watchdog(1), retry, begin).attempt).toBe(2);
  });
});
