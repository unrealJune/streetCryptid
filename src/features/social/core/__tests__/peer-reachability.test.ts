import type { PresenceState } from '../presence';
import {
  ANSWER_RATE_FLOOR,
  dialBudgetMs,
  foldObservation,
  initialReachability,
  MAX_DIAL_BUDGET_MS,
  MIN_DIAL_BUDGET_MS,
  type PeerObservation,
  type PeerReachability,
  pushBudgetMs,
} from '../peer-reachability';

const T0 = 1_700_000_000_000;

const answered = (latencyMs: number, at = T0): PeerObservation => ({
  answered: true,
  latencyMs,
  at,
});
const silent = (at = T0): PeerObservation => ({ answered: false, at });

/** Fold a run of identical outcomes, as a sequence of pushes would. */
const foldMany = (
  start: PeerReachability,
  outcome: PeerObservation,
  times: number
): PeerReachability => {
  let state = start;
  for (let i = 0; i < times; i += 1) state = foldObservation(state, { ...outcome, at: T0 + i });
  return state;
};

const budgetFor = (presence: PresenceState, history?: PeerReachability): number =>
  dialBudgetMs({ kind: 'friend', presence, history });

describe('cold-start priors', () => {
  it('grants a live friend a real budget and a lapsed one none', () => {
    expect(budgetFor('live')).toBeGreaterThan(0);
    expect(budgetFor('lapsed')).toBe(0);
    expect(budgetFor('out-of-contact')).toBe(0);
  });

  it('treats no-fix as a HIGH reachability state, not a failure', () => {
    // `no-fix` means the app is running and said so — it just cannot resolve a position. It is
    // evidence of a live process, and must not be lumped in with the silent states.
    expect(budgetFor('no-fix')).toBeGreaterThan(0);
    expect(budgetFor('no-fix')).toBeGreaterThan(budgetFor('parked'));
    expect(budgetFor('no-fix')).toBeGreaterThan(budgetFor('out-of-contact'));
  });

  it('ranks presence states by how much they prove about the sender running', () => {
    expect(budgetFor('live')).toBeGreaterThanOrEqual(budgetFor('recent'));
    expect(budgetFor('recent')).toBeGreaterThanOrEqual(budgetFor('parked'));
  });

  it('gives the stash a generous budget without it being a special case downstream', () => {
    expect(dialBudgetMs({ kind: 'stash', presence: 'unknown' })).toBeGreaterThan(0);
  });

  it('clamps every prior into the usable band', () => {
    const states: PresenceState[] = [
      'live',
      'recent',
      'parked',
      'no-fix',
      'out-of-contact',
      'lapsed',
      'unknown',
    ];
    for (const state of states) {
      const budget = budgetFor(state);
      expect(budget === 0 || budget >= MIN_DIAL_BUDGET_MS).toBe(true);
      expect(budget).toBeLessThanOrEqual(MAX_DIAL_BUDGET_MS);
    }
  });
});

describe('learning from observations', () => {
  it('drops a peer that keeps going silent to zero', () => {
    // The 74%-of-pushes case: a peer that never answers must stop costing us a budget at all.
    const history = foldMany(initialReachability('friend', 'live', T0), silent(), 20);
    expect(history.answerRate).toBeLessThan(ANSWER_RATE_FLOOR);
    expect(budgetFor('live', history)).toBe(0);
  });

  it('does not let silence inflate the latency estimate', () => {
    // A timeout teaches us the peer did not answer, not that it is slow. Folding the timeout into
    // the latency mean would grow the budget of exactly the peers we want to stop waiting on.
    const start = initialReachability('friend', 'live', T0);
    const afterSilence = foldMany(start, silent(), 5);
    expect(afterSilence.latencyMeanMs).toBe(start.latencyMeanMs);
    expect(afterSilence.latencySpreadMs).toBe(start.latencySpreadMs);
  });

  it('splits two parked peers by behaviour alone, without naming a platform', () => {
    // The platform question, resolved without a platform field. An Android phone parked behind the
    // location foreground service still has a live process and answers immediately; a parked
    // iPhone is riding BGProcessing wakes and is simply not there. Same presence state, same
    // prior, opposite outcomes — learned from what each one actually did.
    const answers = foldMany(initialReachability('friend', 'parked', T0), answered(900), 15);
    const silence = foldMany(initialReachability('friend', 'parked', T0), silent(), 15);
    expect(answers.answerRate).toBeGreaterThan(0.8);
    expect(budgetFor('parked', answers)).toBeGreaterThan(0);
    expect(budgetFor('parked', silence)).toBe(0);
  });

  it('shrinks towards the prior so one bad push cannot cut off a good peer', () => {
    const start = initialReachability('friend', 'live', T0);
    const oneTimeout = foldObservation(start, silent());
    expect(budgetFor('live', oneTimeout)).toBeGreaterThan(0);
  });

  it('tightens the budget for a peer that answers consistently fast', () => {
    const fast = foldMany(initialReachability('friend', 'live', T0), answered(400), 20);
    expect(budgetFor('live', fast)).toBeLessThan(budgetFor('live'));
    expect(budgetFor('live', fast)).toBeGreaterThanOrEqual(MIN_DIAL_BUDGET_MS);
  });

  it('never exceeds the ceiling for a peer that answers slowly but reliably', () => {
    const slow = foldMany(initialReachability('friend', 'live', T0), answered(60_000), 20);
    expect(budgetFor('live', slow)).toBe(MAX_DIAL_BUDGET_MS);
  });

  it('counts every observation, answered or not', () => {
    let state = initialReachability('friend', 'live', T0);
    state = foldObservation(state, answered(500));
    state = foldObservation(state, silent());
    expect(state.samples).toBe(2);
  });

  it('records when it last learned something', () => {
    const state = foldObservation(
      initialReachability('friend', 'live', T0),
      answered(500, T0 + 99)
    );
    expect(state.updatedAt).toBe(T0 + 99);
  });

  it('ignores a nonsensical latency on an answered dial', () => {
    const start = initialReachability('friend', 'live', T0);
    const folded = foldObservation(start, { answered: true, latencyMs: -1, at: T0 });
    expect(folded.latencyMeanMs).toBe(start.latencyMeanMs);
    expect(folded.answerRate).toBeGreaterThan(start.answerRate);
  });
});

describe('pushBudgetMs', () => {
  it('is the slowest budget granted, since that is what the wake pays', () => {
    expect(pushBudgetMs([1_500, 8_000, 3_000])).toBe(8_000);
  });

  it('is zero when nobody is worth waiting for', () => {
    // The push still writes and broadcasts locally; it just does not block a headless wake on a
    // room of sleeping phones.
    expect(pushBudgetMs([0, 0, 0])).toBe(0);
    expect(pushBudgetMs([])).toBe(0);
  });

  it('collapses the measured worst case', () => {
    // The (dialed 3, finished 2, failed 0) shape that occurred 258 times in 96h: stash and one
    // awake friend answer in about a second, one parked iPhone never does. Old cost: the full 30s.
    const stash = dialBudgetMs({ kind: 'stash', presence: 'unknown' });
    const awake = budgetFor(
      'live',
      foldMany(initialReachability('friend', 'live', T0), answered(800), 20)
    );
    const asleep = budgetFor(
      'parked',
      foldMany(initialReachability('friend', 'parked', T0), silent(), 20)
    );
    expect(asleep).toBe(0);
    expect(pushBudgetMs([stash, awake, asleep])).toBeLessThanOrEqual(MAX_DIAL_BUDGET_MS);
    expect(pushBudgetMs([stash, awake, asleep])).toBeLessThan(30_000);
  });
});
