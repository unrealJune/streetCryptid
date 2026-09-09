import type { PresenceState } from './presence';

/**
 * How long to wait on each peer during a durable push, decided per peer rather than once for all.
 *
 * The push used to take ONE 30s budget (`PUSH_TIMEOUT_SECS`) and break only when every dialled
 * peer had reported — finished or failed. Measured over 96h that meant **738 of 993 pushes (74%)
 * burned the entire budget**, and the span attributes say why: in nearly all of them
 * `peers_failed` was 0. The missing peers did not refuse, they said NOTHING. An asleep phone
 * produces no `SyncFinished` either way, so `finished + failed >= expected` never held and the
 * loop waited out the deadline. The canonical case was `(dialed 3, finished 2, failed 0)` — the
 * stash and one awake friend answered in about a second, then 29 more seconds elapsed waiting on a
 * phone in someone's pocket. That single shape occurred 258 times.
 *
 * Waiting is the only thing being removed. Returning early does not cancel the exchange: the
 * namespace stays marked syncing, so a peer that wakes later still reconciles on its own, and any
 * peer that does answer is unaffected by what we predicted about it.
 *
 * There is deliberately NO privileged "required" peer here — not even the stash. A stash-disabled
 * deployment (BYO servers, see the privacy work) has only pool members, and a model that hard-codes
 * the stash as the thing worth waiting for degrades to "wait for nobody" exactly there. Instead the
 * stash earns its budget: it is always up, so it answers fast every time, so its learned answer
 * rate sits near 1 and its budget stays generous. Merit, not a special case.
 */

/**
 * Ceiling on any single peer's budget.
 *
 * **A budget is a DEADLINE, not a wait.** The push ends once every peer has either reported or run
 * out of budget, so a peer granted 20s that answers in 400ms costs 400ms. Being generous here is
 * therefore close to free, and being stingy is not: it only ever truncates peers that would have
 * answered. Every millisecond this model actually saves comes from {@link ANSWER_RATE_FLOOR}
 * zeroing peers that answer nothing, never from a tight ceiling.
 *
 * Calibrated against 7 days of `trail.push`. Among *complete* pushes — the only ones whose duration
 * is interpretable, because nothing was censored by the old 30s cap — the slowest real answer was
 * p50 613ms but p90 8.9s and p95 17.3s, and among those that actually delivered entries p90 was
 * 16.7s. 20s covers ~90% of real deliveries. An earlier 12s draft was set from a guess and would
 * have truncated about one delivering push in seven for no saving at all.
 */
export const MAX_DIAL_BUDGET_MS = 20_000;

/**
 * Below this a budget is not worth the dial at all, so it collapses to zero.
 *
 * A sub-second budget cannot survive a cold node's `net_report` and hole-punch, so granting one
 * means paying the dial cost to reliably time out. Round down to not dialling.
 */
export const MIN_DIAL_BUDGET_MS = 1_500;

/**
 * Answer rate below which we stop waiting on a peer entirely.
 *
 * Set where it is because the cost is asymmetric. Waiting on a peer that will not answer costs the
 * whole budget on EVERY push; skipping one that would have answered costs a delayed reconciliation
 * it will perform itself when it next wakes. One in five is already a bad trade.
 */
export const ANSWER_RATE_FLOOR = 0.2;

/** How much a new observation moves the estimate. ~10 pushes to substantially re-learn a peer. */
export const EWMA_ALPHA = 0.2;

/** Observations before the learned estimate is trusted over the presence prior outright. */
export const SHRINKAGE_SAMPLES = 5;

/**
 * What a peer is, for the purpose of a cold-start guess only.
 *
 * Not used once {@link PeerReachability} has samples — see the module note on merit over special
 * cases.
 */
export type PeerKind = 'stash' | 'friend';

/**
 * A peer's measured behaviour in ONE presence state.
 *
 * Keyed per state on purpose, and this is the whole reason the model is worth building. "Parked"
 * does not mean the same thing on both platforms: an Android phone parked with sharing on still has
 * a live process behind the location foreground service and answers immediately, while a parked
 * iPhone is riding `BGProcessing` wakes at p50 5min / p90 92min / 17h tail and is simply not there.
 * Conditioning on `(peer, state)` lets those two diverge from observation without the model ever
 * naming a platform — which also means it cannot rot when OS behaviour changes underneath it.
 */
export interface PeerReachability {
  /** EWMA probability this peer answers a dial in this state at all. */
  answerRate: number;
  /** EWMA of observed answer latency (ms), over answered dials only. */
  latencyMeanMs: number;
  /** EWMA of |latency - mean|, a cheap dispersion term used to pad the budget. */
  latencySpreadMs: number;
  /** Observations folded in so far. Drives shrinkage towards the prior. */
  samples: number;
  /** When this was last updated (ms since epoch). */
  updatedAt: number;
}

/** One dial's outcome, as reported by the native push. */
export interface PeerObservation {
  /** Whether a `SyncFinished` arrived for this peer inside its budget. */
  answered: boolean;
  /** Time to that `SyncFinished`. Required when {@link answered}, ignored otherwise. */
  latencyMs?: number;
  /** When the dial happened (ms since epoch). */
  at: number;
}

/**
 * Cold-start guess at how a peer in each presence state behaves.
 *
 * **`latencyMs` here is CONDITIONAL on the peer answering** — "when this one does reply, how long
 * does it take?" — and the two fields must not be used to say the same thing twice. An early draft
 * of this table set a high latency for the pessimistic states, as though "unlikely to answer" also
 * meant "slow to answer". That is wrong on the facts (a dial that succeeds succeeds at roughly the
 * same speed whoever it is) and it inverted the model: because the budget grows with latency, the
 * peers least likely to reply were handed the LARGEST budgets — precisely the behaviour this file
 * exists to delete. All the discrimination belongs in `answerRate`.
 *
 * The ordering that matters and is easy to get backwards: **`no-fix` is a HIGH-reachability
 * state.** It means the sender's app is running and told us so, and merely cannot resolve a
 * position — indoors, a tunnel. It looks like a failure and is the opposite: a process that is
 * demonstrably alive.
 *
 * `parked` is pessimistic only until observation says otherwise, because on the platform where
 * parked phones do answer, they will answer here too and the estimate moves within a few pushes.
 *
 * The latencies are deliberately GENEROUS for a cold start. A first draft set them tight (2–3s) and
 * had it exactly backwards: they apply when we know least about a peer, and — since a budget is a
 * deadline, not a wait (see {@link MAX_DIAL_BUDGET_MS}) — an over-generous prior costs nothing on a
 * peer that answers promptly, while an over-tight one truncates it and then teaches us it did not
 * answer. Tightening is the learned layer's job, and it does it within a handful of pushes.
 */
const PRESENCE_PRIOR: Record<PresenceState, { answerRate: number; latencyMs: number }> = {
  // Heard from within the last 15 minutes with a current position: awake, publishing, reachable.
  live: { answerRate: 0.9, latencyMs: 4_000 },
  // Alive recently enough to be unremarkable, but may have been suspended since.
  recent: { answerRate: 0.6, latencyMs: 5_000 },
  // App is running and saying so — it just has no GPS. See the note above.
  'no-fix': { answerRate: 0.85, latencyMs: 4_500 },
  // Declared stopped. On iOS that usually means no process at all; Android will correct this.
  parked: { answerRate: 0.25, latencyMs: 5_000 },
  // Was moving and went silent. Something is wrong with them; dialling rarely helps.
  'out-of-contact': { answerRate: 0.05, latencyMs: 6_000 },
  // Their app has not run for about a day.
  lapsed: { answerRate: 0.02, latencyMs: 6_000 },
  // No fix from them at all — could be a fresh pair that has never published. Worth a probe.
  unknown: { answerRate: 0.4, latencyMs: 6_000 },
};

/** The stash is a server: always up, fast, and it answers. Replaced by observation like any peer. */
const STASH_PRIOR = { answerRate: 0.95, latencyMs: 3_000 };

/** A peer we have never dialled in this state, seeded from the prior. */
export function initialReachability(
  kind: PeerKind,
  presence: PresenceState,
  now: number
): PeerReachability {
  const prior = kind === 'stash' ? STASH_PRIOR : PRESENCE_PRIOR[presence];
  return {
    answerRate: prior.answerRate,
    latencyMeanMs: prior.latencyMs,
    // Start wide: with no evidence, a generous pad is cheaper than under-budgeting a peer that
    // would have answered and teaching ourselves it does not.
    latencySpreadMs: prior.latencyMs * 0.5,
    samples: 0,
    updatedAt: now,
  };
}

/**
 * Fold one dial outcome into a peer's estimate.
 *
 * A silent peer moves `answerRate` and nothing else: we learned that it did not answer, not how
 * slow it is. Letting a timeout drag `latencyMeanMs` upward would inflate the budget of exactly
 * the peers we want to stop waiting on — the failure mode this model exists to end.
 */
export function foldObservation(
  current: PeerReachability,
  observation: PeerObservation
): PeerReachability {
  const answered = observation.answered;
  const answerRate = current.answerRate + EWMA_ALPHA * ((answered ? 1 : 0) - current.answerRate);
  let latencyMeanMs = current.latencyMeanMs;
  let latencySpreadMs = current.latencySpreadMs;
  if (answered && typeof observation.latencyMs === 'number' && observation.latencyMs >= 0) {
    const deviation = Math.abs(observation.latencyMs - current.latencyMeanMs);
    latencyMeanMs =
      current.latencyMeanMs + EWMA_ALPHA * (observation.latencyMs - current.latencyMeanMs);
    latencySpreadMs = current.latencySpreadMs + EWMA_ALPHA * (deviation - current.latencySpreadMs);
  }
  return {
    answerRate,
    latencyMeanMs,
    latencySpreadMs,
    samples: current.samples + 1,
    updatedAt: observation.at,
  };
}

/**
 * The budget to grant this peer on the next push, in milliseconds. Zero means do not wait for it.
 *
 * Shrinks towards the presence prior while samples are thin, so one unlucky timeout on a good peer
 * cannot cut it off — and so a peer whose presence state just changed is judged mostly on what that
 * state implies until it has behaved a few times in the new one.
 */
export function dialBudgetMs(input: {
  kind: PeerKind;
  presence: PresenceState;
  history?: PeerReachability;
  now?: number;
}): number {
  const { kind, presence, history } = input;
  const prior = kind === 'stash' ? STASH_PRIOR : PRESENCE_PRIOR[presence];
  if (!history || history.samples === 0) {
    return budgetFrom(prior.answerRate, prior.latencyMs, prior.latencyMs * 0.5);
  }
  // Shrinkage: `weight` is how far we trust the measurement over the prior.
  const weight = Math.min(1, history.samples / SHRINKAGE_SAMPLES);
  const answerRate = prior.answerRate + weight * (history.answerRate - prior.answerRate);
  const latencyMeanMs = prior.latencyMs + weight * (history.latencyMeanMs - prior.latencyMs);
  const spread = prior.latencyMs * 0.5 + weight * (history.latencySpreadMs - prior.latencyMs * 0.5);
  return budgetFrom(answerRate, latencyMeanMs, spread);
}

/**
 * Turn a belief about a peer into a number of milliseconds.
 *
 * Two terms, and both are needed for the budget to move in the right direction:
 *
 * - `mean + 2 * spread` is a cheap stand-in for a high quantile of the answer-latency
 *   distribution: budget for the slow-but-real answers, not the median one. Deliberately not a
 *   true p90 — we hold three EWMA scalars per peer, not a histogram, and the extra fidelity would
 *   not change a decision that is then clamped into a {@link MIN_DIAL_BUDGET_MS}–
 *   {@link MAX_DIAL_BUDGET_MS} band anyway.
 * - Scaling by `answerRate` is what makes waiting proportional to the chance of being rewarded for
 *   it. Waiting `T` on a peer that answers with probability `p` wastes `T * (1 - p)` on average, so
 *   a peer we half believe in gets half a window — a probe, not a vigil. Without this term the
 *   budget depends only on latency and an unlikely peer costs exactly as much as a certain one.
 */
function budgetFrom(answerRate: number, latencyMeanMs: number, latencySpreadMs: number): number {
  if (answerRate < ANSWER_RATE_FLOOR) return 0;
  const quantile = latencyMeanMs + 2 * Math.max(0, latencySpreadMs);
  const raw = quantile * Math.min(1, answerRate);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const clamped = Math.min(MAX_DIAL_BUDGET_MS, raw);
  return clamped < MIN_DIAL_BUDGET_MS ? MIN_DIAL_BUDGET_MS : Math.round(clamped);
}

/**
 * The whole push's wall-clock cost: the slowest budget we granted anyone.
 *
 * Worth having as a named function because it is the number the background wake actually pays, and
 * the one to assert against in tests. With no peer worth waiting for it is 0 — the push still
 * writes and broadcasts locally, it just does not block a headless wake on a room of sleeping
 * phones.
 */
export function pushBudgetMs(budgets: readonly number[]): number {
  return budgets.reduce((max, value) => (value > max ? value : max), 0);
}
