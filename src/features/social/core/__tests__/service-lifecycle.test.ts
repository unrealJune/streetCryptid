import {
  canRetryService,
  INITIAL_SERVICE_LIFECYCLE,
  isServiceReady,
  reduceServiceLifecycle,
  type ServiceLifecycle,
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
    expect(state).toEqual({ phase: 'ready', attempt: 1, error: null, initPhase: null });
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
    expect(state).toEqual({ phase: 'initializing', attempt: 2, error: null, initPhase: null });
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
    const walk = (state: ServiceLifecycle, depth: number) => {
      phases.add(state.phase);
      if (depth === 0) return;
      for (const event of events(state.attempt)) {
        const next = reduceServiceLifecycle(state, event);
        sequences += 1;
        expect(next.attempt).toBeGreaterThanOrEqual(state.attempt);
        if (next.phase === 'ready') expect(next.attempt).toBeGreaterThan(0);
        if (next.phase === 'initializing') expect(canRetryService(next)).toBe(false);
        if (next !== state) expect(next).not.toEqual(state);
        if (next.phase === 'ready' || next.phase === 'initializing') {
          expect(next.error).toBeNull();
        }
        walk(next, depth - 1);
      }
    };
    walk(INITIAL_SERVICE_LIFECYCLE, 6);
    expect(sequences).toBeGreaterThan(100_000);
    expect([...phases].sort()).toEqual(['failed', 'idle', 'initializing', 'ready', 'stalled']);
  });
});
