import {
  canPoll,
  INITIAL_PAIRING_POLL,
  stepPairingPoll,
  type PairingPollEffect,
  type PairingPollEvent,
  type PairingPollState,
  type PollConfig,
  type RequestOutcome,
} from '../pairing-poll-driver';

const CONFIG: PollConfig = { idleMs: 4_000, busyMs: 300, maxStalled: 2 };

function play(...events: PairingPollEvent[]): {
  state: PairingPollState;
  effects: PairingPollEffect[];
} {
  let state = INITIAL_PAIRING_POLL;
  const effects: PairingPollEffect[] = [];
  for (const event of events) {
    const step = stepPairingPoll(state, event, CONFIG);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const ready = { type: 'ready' } as const;
const foreground = { type: 'foreground' } as const;
const background = { type: 'background' } as const;
const rebindStart = { type: 'rebindStart' } as const;
const rebindEnd = { type: 'rebindEnd' } as const;
const stop = { type: 'stop' } as const;
const request = (id: number) => ({ type: 'request', id }) as const;
const tick = (timer: number) => ({ type: 'tick', timer }) as const;
const fetched = (gen: number) => ({ type: 'fetched', gen }) as const;
const applied = (gen: number) => ({ type: 'applied', gen }) as const;
const stallTimer = (gen: number) => ({ type: 'stallTimer', gen }) as const;
const of = <T extends PairingPollEffect['type']>(effects: PairingPollEffect[], type: T) =>
  effects.filter((e): e is Extract<PairingPollEffect, { type: T }> => e.type === type);

describe('pairing poll driver', () => {
  describe('the gate', () => {
    it('does not poll before ready, whatever asks', () => {
      const { effects } = play(foreground, request(1), background, foreground, tick(1));
      expect(of(effects, 'startPoll')).toEqual([]);
      expect(of(effects, 'resolve')).toEqual([{ type: 'resolve', ids: [1], outcome: 'skipped' }]);
    });

    it('starts its cadence on ready', () => {
      const { effects } = play(ready);
      expect(effects).toEqual([{ type: 'armTimer', timer: 1, delayMs: 4_000 }]);
    });

    it('does not poll in the background, and closes the gap on return', () => {
      const away = play(ready, background, request(1), tick(1));
      expect(of(away.effects, 'startPoll')).toEqual([]);
      expect(of(away.effects, 'cancelTimer')).toEqual([{ type: 'cancelTimer', timer: 1 }]);
      const back = stepPairingPoll(away.state, foreground, CONFIG);
      expect(of([...back.effects], 'startPoll')).toEqual([{ type: 'startPoll', gen: 1 }]);
    });

    it('starts no poll while the node is being rebuilt', () => {
      const { effects } = play(ready, rebindStart, request(1), tick(1));
      expect(of(effects, 'startPoll')).toEqual([]);
      const after = play(ready, rebindStart, rebindEnd);
      expect(of(after.effects, 'armTimer')).toHaveLength(2);
    });

    it('is dead after stop, and answers everyone at once', () => {
      const { state, effects } = play(ready, request(1), request(2), stop, request(3), tick(2));
      expect(of(effects, 'resolve')).toEqual([
        { type: 'resolve', ids: [2], outcome: 'skipped' },
        { type: 'resolve', ids: [1], outcome: 'skipped' },
        { type: 'resolve', ids: [3], outcome: 'skipped' },
      ]);
      expect(of(effects, 'startPoll')).toHaveLength(1);
      // The poll that was running is still absorbed, and its results are dropped.
      const landed = stepPairingPoll(state, fetched(1), CONFIG);
      expect(landed.effects).toEqual([{ type: 'apply', gen: 1, mode: 'drop' }]);
    });
  });

  describe('requests', () => {
    it('starts a poll for a request when idle', () => {
      const { effects } = play(ready, request(1));
      expect(of(effects, 'startPoll')).toEqual([{ type: 'startPoll', gen: 1 }]);
      expect(of(effects, 'cancelTimer')).toEqual([{ type: 'cancelTimer', timer: 1 }]);
    });

    /** A refresh never gets an answer older than its question. */
    it('answers a request made during a poll with the NEXT poll', () => {
      const { effects } = play(ready, request(1), request(2), fetched(1), applied(1));
      expect(of(effects, 'resolve')).toEqual([{ type: 'resolve', ids: [1], outcome: 'ok' }]);
      expect(of(effects, 'startPoll')).toEqual([
        { type: 'startPoll', gen: 1 },
        { type: 'startPoll', gen: 2 },
      ]);
      const done = play(
        ready,
        request(1),
        request(2),
        fetched(1),
        applied(1),
        fetched(2),
        applied(2)
      );
      expect(of(done.effects, 'resolve')).toContainEqual({
        type: 'resolve',
        ids: [2],
        outcome: 'ok',
      });
    });

    it('re-arms the cadence after a poll, at the busy rate when busy', () => {
      const { effects } = play(
        ready,
        request(1),
        { type: 'busy', busy: true },
        fetched(1),
        applied(1)
      );
      expect(of(effects, 'armTimer').at(-1)).toEqual({ type: 'armTimer', timer: 2, delayMs: 300 });
    });
  });

  describe('a poll that hangs', () => {
    /** The rule that would have kept pairing alive on the 2026-10-13 Pixel. */
    it('is reported once, released, and no longer blocks anyone', () => {
      const { effects } = play(ready, request(1), stallTimer(1), stallTimer(1), request(2));
      expect(of(effects, 'reportStalled')).toEqual([{ type: 'reportStalled', gen: 1 }]);
      expect(of(effects, 'resolve')).toContainEqual({
        type: 'resolve',
        ids: [1],
        outcome: 'stalled',
      });
      expect(of(effects, 'startPoll')).toEqual([
        { type: 'startPoll', gen: 1 },
        { type: 'startPoll', gen: 2 },
      ]);
    });

    it('hands a request waiting on it to a fresh poll', () => {
      const { effects } = play(ready, request(1), request(2), stallTimer(1));
      expect(of(effects, 'startPoll').at(-1)).toEqual({ type: 'startPoll', gen: 2 });
    });

    it('stops starting polls once too many are stalled, without leaving anyone waiting', () => {
      const { state, effects } = play(
        ready,
        request(1),
        stallTimer(1),
        request(2),
        request(3),
        stallTimer(2)
      );
      expect(state.stalled).toEqual([1, 2]);
      expect(of(effects, 'startPoll')).toHaveLength(2);
      expect(of(effects, 'resolve')).toContainEqual({
        type: 'resolve',
        ids: [3],
        outcome: 'stalled',
      });
      expect(state.waiting).toEqual([]);
      const blocked = stepPairingPoll(state, request(4), CONFIG);
      expect(blocked.effects).toEqual([{ type: 'resolve', ids: [4], outcome: 'stalled' }]);
    });

    it('lands late without overwriting what a newer poll read', () => {
      const { effects } = play(
        ready,
        request(1),
        stallTimer(1),
        request(2),
        fetched(2),
        applied(2),
        fetched(1),
        applied(1)
      );
      expect(of(effects, 'apply')).toEqual([
        { type: 'apply', gen: 2, mode: 'normal' },
        { type: 'apply', gen: 1, mode: 'late' },
      ]);
      expect(of(effects, 'reportLate')).toEqual([{ type: 'reportLate', gen: 1 }]);
    });

    it('applies normally if it lands before anything newer has read', () => {
      const { effects } = play(ready, request(1), stallTimer(1), request(2), fetched(1));
      expect(of(effects, 'apply')).toEqual([{ type: 'apply', gen: 1, mode: 'normal' }]);
    });
  });

  /**
   * Every sequence of up to five events a phone can produce, with a ledger of what has been asked
   * and answered, against the rules in the module docs. The events are generated from the state
   * so that each one is one the runner could actually deliver (a poll is fetched before it is
   * applied, and each only once), plus stale and unknown completions it must ignore.
   */
  // An explicit budget: a few hundred thousand steps is seconds here and could be more on a cold
  // CI runner, and this test must fail on a broken rule, never on a slow machine.
  it('keeps every rule across every short sequence of events', () => {
    interface Ledger {
      /** Request id → the sequence index it was made at. */
      readonly issued: ReadonlyMap<number, number>;
      readonly resolved: ReadonlyMap<number, RequestOutcome>;
      /** Gen → the sequence index it started at. */
      readonly started: ReadonlyMap<number, number>;
      readonly fetched: ReadonlySet<number>;
      readonly applied: ReadonlySet<number>;
      readonly stalledEver: ReadonlySet<number>;
      readonly lateReported: ReadonlySet<number>;
      readonly lastNormalApply: number;
      readonly nextRequest: number;
    }
    const events = (state: PairingPollState, ledger: Ledger): PairingPollEvent[] => {
      const out: PairingPollEvent[] = [
        ready,
        foreground,
        background,
        rebindStart,
        rebindEnd,
        stop,
        { type: 'busy', busy: !state.busy },
        request(ledger.nextRequest),
        tick(state.timer ?? state.nextTimer),
        tick((state.timer ?? state.nextTimer) - 1),
        stallTimer(state.inFlight?.gen ?? state.nextGen),
      ];
      // Every poll started and not yet over can be fetched, then applied — in any order across
      // polls, since a stalled one may land at any time.
      for (const gen of ledger.started.keys()) {
        if (!ledger.fetched.has(gen)) out.push(fetched(gen));
        else if (!ledger.applied.has(gen)) out.push(applied(gen));
      }
      return out;
    };
    const fail = (message: string): never => {
      throw new Error(message);
    };
    let sequences = 0;
    const reached = new Set<string>();
    const walk = (
      state: PairingPollState,
      ledger: Ledger,
      depth: number,
      path: { toString(): string }
    ) => {
      if (depth === 0) return;
      for (const event of events(state, ledger)) {
        const { state: next, effects } = stepPairingPoll(state, event, CONFIG);
        sequences += 1;
        const at = sequences;
        const here = { toString: () => `${String(path)} > ${JSON.stringify(event)}` };
        const issued = new Map(ledger.issued);
        const resolved = new Map(ledger.resolved);
        const started = new Map(ledger.started);
        const fetchedSet = new Set(ledger.fetched);
        const appliedSet = new Set(ledger.applied);
        const stalledEver = new Set(ledger.stalledEver);
        const lateReported = new Set(ledger.lateReported);
        let lastNormalApply = ledger.lastNormalApply;
        let nextRequest = ledger.nextRequest;
        if (event.type === 'request') {
          issued.set(event.id, at);
          nextRequest += 1;
        }
        if (event.type === 'fetched') fetchedSet.add(event.gen);
        if (event.type === 'applied') appliedSet.add(event.gen);

        if (next === state && effects.length > 0 && event.type !== 'request') {
          if (!(state.gate.stopped && event.type === 'fetched')) {
            fail(`effects without a state change: ${here}`);
          }
        }
        for (const effect of effects) {
          reached.add(
            effect.type === 'apply'
              ? `apply:${effect.mode}`
              : effect.type === 'resolve'
                ? `resolve:${effect.outcome}`
                : effect.type
          );
          switch (effect.type) {
            case 'startPoll':
              // Rule 1: only through an open gate. Rule 2: one at a time.
              if (!canPoll(next)) fail(`poll through a closed gate: ${here}`);
              // The poll before it must be over (applied) or released (stalled) by this very event.
              if (
                state.inFlight !== null &&
                !(
                  (event.type === 'applied' || event.type === 'stallTimer') &&
                  event.gen === state.inFlight.gen
                )
              ) {
                fail(`second poll in flight: ${here}`);
              }
              if (started.has(effect.gen)) fail(`gen ${effect.gen} started twice: ${here}`);
              started.set(effect.gen, at);
              break;
            case 'armTimer':
              if (!canPoll(next) || next.inFlight !== null) fail(`timer while not idle: ${here}`);
              break;
            case 'resolve':
              for (const id of effect.ids) {
                if (!issued.has(id)) fail(`resolved an unknown request ${id}: ${here}`);
                if (resolved.has(id)) fail(`request ${id} resolved twice: ${here}`);
                resolved.set(id, effect.outcome);
                if (effect.outcome === 'ok') {
                  // Rule 3: answered by a poll that started after it was asked.
                  if (event.type !== 'applied') fail(`ok outside a poll's end: ${here}`);
                  const startedAt = started.get(event.type === 'applied' ? event.gen : -1) ?? -1;
                  if (startedAt < issued.get(id)!) fail(`stale answer for ${id}: ${here}`);
                }
              }
              break;
            case 'apply':
              if (effect.mode === 'normal') {
                // Rule 5: normal applies only ever move forward.
                if (effect.gen <= lastNormalApply) fail(`normal apply went back: ${here}`);
                lastNormalApply = effect.gen;
              }
              if (state.gate.stopped && effect.mode !== 'drop') fail(`applied after stop: ${here}`);
              break;
            case 'reportStalled':
              if (stalledEver.has(effect.gen)) fail(`stall reported twice: ${here}`);
              stalledEver.add(effect.gen);
              break;
            case 'reportLate':
              if (!stalledEver.has(effect.gen) || lateReported.has(effect.gen)) {
                fail(`late report for a poll that never stalled: ${here}`);
              }
              lateReported.add(effect.gen);
              break;
            case 'cancelTimer':
            case 'armStall':
              break;
          }
        }
        // Structural rules, on every state reached.
        if (next.stalled.length > CONFIG.maxStalled) fail(`too many stalled: ${here}`);
        if (next.timer !== null && (!canPoll(next) || next.inFlight !== null)) {
          fail(`timer armed while not idle: ${here}`);
        }
        if (next.waiting.length > 0 && next.inFlight === null) {
          fail(`waiting on nothing: ${here}`);
        }
        // Rule 4: every request is answered or held by a poll that will answer it.
        const held = new Set([...next.waiting, ...(next.inFlight?.requests ?? [])]);
        for (const id of issued.keys()) {
          if (!resolved.has(id) && !held.has(id)) fail(`request ${id} lost: ${here}`);
        }
        if (next.gate.stopped && held.size > 0) fail(`stopped with someone waiting: ${here}`);

        walk(
          next,
          {
            issued,
            resolved,
            started,
            fetched: fetchedSet,
            applied: appliedSet,
            stalledEver,
            lateReported,
            lastNormalApply,
            nextRequest,
          },
          depth - 1,
          here
        );
      }
    };
    // Five events deep from each of several starting points, so the deep states — a stalled poll
    // landing behind a newer one, a stop with polls outstanding — are reached as well as the shallow.
    const seeds: PairingPollEvent[][] = [
      [],
      [ready],
      [ready, request(1)],
      [ready, request(1), stallTimer(1), request(2)],
      [ready, request(1), stallTimer(1), request(2), stallTimer(2)],
    ];
    const emptyLedger: Ledger = {
      issued: new Map(),
      resolved: new Map(),
      started: new Map(),
      fetched: new Set(),
      applied: new Set(),
      stalledEver: new Set(),
      lateReported: new Set(),
      lastNormalApply: 0,
      nextRequest: 1,
    };
    for (const seed of seeds) {
      // Replay the seed through the same checks by walking it one forced event at a time.
      let state = INITIAL_PAIRING_POLL;
      const ledger = {
        ...emptyLedger,
        issued: new Map<number, number>(),
        resolved: new Map<number, RequestOutcome>(),
        started: new Map<number, number>(),
        stalledEver: new Set<number>(),
      };
      for (const event of seed) {
        const step = stepPairingPoll(state, event, CONFIG);
        if (event.type === 'request') {
          ledger.issued.set(event.id, -1);
          ledger.nextRequest = event.id + 1;
        }
        for (const effect of step.effects) {
          if (effect.type === 'startPoll') ledger.started.set(effect.gen, 0);
          if (effect.type === 'reportStalled') ledger.stalledEver.add(effect.gen);
          if (effect.type === 'resolve') {
            for (const id of effect.ids) ledger.resolved.set(id, effect.outcome);
          }
        }
        state = step.state;
      }
      walk(state, ledger, 5, `seed ${JSON.stringify(seed)}`);
    }
    // Proof the walk ran, rather than vacuously passing, and reached every kind of outcome.
    expect(sequences).toBeGreaterThan(5 * 11 ** 5);
    expect([...reached].sort()).toEqual([
      'apply:drop',
      'apply:late',
      'apply:normal',
      'armStall',
      'armTimer',
      'cancelTimer',
      'reportLate',
      'reportStalled',
      'resolve:ok',
      'resolve:skipped',
      'resolve:stalled',
      'startPoll',
    ]);
  }, 60_000);
});
