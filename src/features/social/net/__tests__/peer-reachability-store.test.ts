import { InMemoryKV } from '../background/persistent-kv';
import {
  type DialOutcome,
  foldOutcomes,
  inferStashPeer,
  loadReachability,
  loadStashPeer,
  planDials,
  type PlannedDial,
  reachabilityKey,
  saveReachability,
  saveStashPeer,
  PEER_REACHABILITY_KEY,
  type ReachabilityMap,
} from '../peer-reachability-store';

const T0 = 1_700_000_000_000;
const FRIEND = 'aa'.repeat(32);
const STASH = 'bb'.repeat(32);

const outcome = (
  over: Partial<DialOutcome> & Pick<DialOutcome, 'peer' | 'outcome'>
): DialOutcome => ({
  latencyMs: null,
  entriesSent: 0,
  budgetMs: 5_000,
  ...over,
});

describe('persistence', () => {
  it('round-trips the map', async () => {
    const kv = new InMemoryKV();
    const map: ReachabilityMap = {
      [reachabilityKey(FRIEND, 'live')]: {
        answerRate: 0.5,
        latencyMeanMs: 1_000,
        latencySpreadMs: 200,
        samples: 3,
        updatedAt: T0,
      },
    };
    await saveReachability(kv, map);
    expect(await loadReachability(kv)).toEqual(map);
  });

  it('treats a corrupt or absent value as empty rather than throwing', async () => {
    const kv = new InMemoryKV();
    expect(await loadReachability(kv)).toEqual({});
    await kv.set(PEER_REACHABILITY_KEY, 'not json');
    expect(await loadReachability(kv)).toEqual({});
    await kv.set(PEER_REACHABILITY_KEY, '[1,2,3]');
    expect(await loadReachability(kv)).toEqual({});
  });

  it('round-trips the learned stash endpoint, normalised', async () => {
    const kv = new InMemoryKV();
    expect(await loadStashPeer(kv)).toBeNull();
    await saveStashPeer(kv, STASH.toUpperCase());
    expect(await loadStashPeer(kv)).toBe(STASH);
  });
});

describe('planDials', () => {
  it('keeps zero-budget peers in the plan so they are recorded as skipped', () => {
    // Dropping them here would make the model unauditable — a rising skip count is the signature
    // of a predictor that has become too aggressive, and it must stay visible.
    const plan = planDials(
      [{ ticket: 't', endpointHex: FRIEND, kind: 'friend', presence: 'lapsed' }],
      {}
    );
    expect(plan).toHaveLength(1);
    expect(plan[0].budgetMs).toBe(0);
  });

  it('uses the stored estimate for the matching presence state only', () => {
    const silent = {
      answerRate: 0.01,
      latencyMeanMs: 1_000,
      latencySpreadMs: 100,
      samples: 20,
      updatedAt: T0,
    };
    const reachability: ReachabilityMap = { [reachabilityKey(FRIEND, 'parked')]: silent };
    const peer = { ticket: 't', endpointHex: FRIEND, kind: 'friend' as const };
    // Parked: the learned silence applies and the peer is not worth waiting for.
    expect(planDials([{ ...peer, presence: 'parked' }], reachability)[0].budgetMs).toBe(0);
    // Live: a different state, so the same peer is judged on the live prior instead.
    expect(planDials([{ ...peer, presence: 'live' }], reachability)[0].budgetMs).toBeGreaterThan(0);
  });

  it('falls back to the prior when the stash endpoint is not yet known', () => {
    const plan = planDials(
      [{ ticket: 'stash', endpointHex: null, kind: 'stash', presence: 'unknown' }],
      {}
    );
    expect(plan[0].budgetMs).toBeGreaterThan(0);
  });
});

describe('foldOutcomes', () => {
  const planned: PlannedDial[] = [
    { ticket: 't', endpointHex: FRIEND, kind: 'friend', presence: 'parked', budgetMs: 2_500 },
  ];

  it('learns from a silent peer', () => {
    let map: ReachabilityMap = {};
    for (let i = 0; i < 20; i += 1) {
      map = foldOutcomes(map, planned, [outcome({ peer: FRIEND, outcome: 'silent' })], T0 + i);
    }
    const learned = map[reachabilityKey(FRIEND, 'parked')];
    expect(learned.answerRate).toBeLessThan(0.05);
    expect(learned.samples).toBe(20);
  });

  it('does NOT learn from a skipped peer', () => {
    // We never dialled it, so it carries no evidence. Folding it would let a peer that once hit a
    // zero budget mark its own homework and never climb back out.
    const map = foldOutcomes(
      {},
      planned,
      [outcome({ peer: FRIEND, outcome: 'skipped', budgetMs: 0 })],
      T0
    );
    expect(map).toEqual({});
  });

  it('records latency from an answering peer', () => {
    const map = foldOutcomes(
      {},
      planned,
      [outcome({ peer: FRIEND, outcome: 'finished', latencyMs: 850, entriesSent: 1 })],
      T0
    );
    const learned = map[reachabilityKey(FRIEND, 'parked')];
    expect(learned.answerRate).toBeGreaterThan(0.25);
    expect(learned.samples).toBe(1);
  });

  it('counts a failure as a non-answer without inflating latency', () => {
    const map = foldOutcomes(
      {},
      planned,
      [outcome({ peer: FRIEND, outcome: 'failed', latencyMs: 26_000 })],
      T0
    );
    const learned = map[reachabilityKey(FRIEND, 'parked')];
    const seeded = foldOutcomes({}, planned, [outcome({ peer: FRIEND, outcome: 'silent' })], T0)[
      reachabilityKey(FRIEND, 'parked')
    ];
    expect(learned.latencyMeanMs).toBe(seeded.latencyMeanMs);
  });

  it('learns an unplanned peer as the stash, which is how it is first discovered', () => {
    const map = foldOutcomes(
      {},
      planned,
      [outcome({ peer: STASH, outcome: 'finished', latencyMs: 700 })],
      T0
    );
    expect(map[reachabilityKey(STASH, 'unknown')]).toBeDefined();
  });

  it('matches peers case-insensitively', () => {
    const map = foldOutcomes(
      {},
      planned,
      [outcome({ peer: FRIEND.toUpperCase(), outcome: 'finished', latencyMs: 500 })],
      T0
    );
    expect(map[reachabilityKey(FRIEND, 'parked')]).toBeDefined();
  });
});

describe('inferStashPeer', () => {
  it('picks the reported peer that is not a friend', () => {
    expect(
      inferStashPeer(
        [
          outcome({ peer: FRIEND, outcome: 'finished' }),
          outcome({ peer: STASH, outcome: 'finished' }),
        ],
        [FRIEND]
      )
    ).toBe(STASH);
  });

  it('returns null when every peer is a known friend, so no stash is invented', () => {
    expect(inferStashPeer([outcome({ peer: FRIEND, outcome: 'finished' })], [FRIEND])).toBeNull();
  });
});
