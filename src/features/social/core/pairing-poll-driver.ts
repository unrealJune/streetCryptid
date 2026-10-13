/**
 * When the pairing poll may run, as one explicit state machine.
 *
 * The poll (`pollPairEvents` + `pollProfileEvents` + `listPairSessions` + BLE reads, then the work
 * of applying them) is what opens the SAS gate, completes a pair and keeps Bump responsive. It used
 * to be driven by three loose fields — a timer, an in-flight promise every caller shared, and a
 * "suspended" flag — and each race on it was a combination nobody had written down:
 *
 * - **A hung poll silenced pairing for good.** Every caller was handed the in-flight promise, and
 *   one that never settled was never released: the timer could not re-arm and a user action waited
 *   on it forever, while the rest of the app looked fine.
 * - **A caller got an answer older than its question.** A refresh made during a poll was handed
 *   that poll, which had read native state before the refresh was asked for.
 * - **The loop ran when it must not.** A foreground during `init` started it before `ready`; an
 *   init that landed after shutdown re-armed it on a dead service; a rebind stopped it but nothing
 *   stopped a poll starting against the node being replaced.
 *
 * So:
 *
 * 1. A poll starts only while the gate is open: `ready && foreground && !rebinding && !stopped`.
 * 2. At most one poll is in flight. One that outlives its stall bound is reported (once), released
 *    and no longer blocks anyone; at most {@link PollConfig.maxStalled} may be outstanding, so a
 *    native layer that is wedged outright does not collect an unbounded pile of hung calls.
 * 3. A request made during a poll is answered by a poll that STARTS after it.
 * 4. A request that cannot be served — gate closed, too many stalled — resolves at once, as
 *    `skipped` or `stalled`. Nothing waits forever on this machine.
 * 5. A poll's results are applied as `normal` only if no newer poll has already read native state;
 *    otherwise `late` (its drained events are still handled — they were drained exactly once — but
 *    its session list must not overwrite a newer one). After `stop` they are `drop`ped.
 * 6. Every completion carries its `gen`, and one that is not current changes nothing.
 *
 * Pure: the runner (`net/pairing-poll-runner.ts`) executes the effects, and every rule is a test
 * (`__tests__/pairing-poll-driver.test.ts` walks every short event sequence).
 */

export interface PollGate {
  /** `init()` reached `ready`. */
  readonly ready: boolean;
  /** The app is on screen. A pair needs two present humans; off screen the poll is pure cost. */
  readonly foreground: boolean;
  /** The node is being rebuilt; a poll now would read the one being replaced. */
  readonly rebinding: boolean;
  /** The service shut down. Terminal. */
  readonly stopped: boolean;
}

export interface PollInFlight {
  readonly gen: number;
  /** Requests this poll will answer: every one was made before it started. */
  readonly requests: readonly number[];
}

export interface PairingPollState {
  readonly gate: PollGate;
  /** A session is live or Bump is armed: poll at the fast cadence. */
  readonly busy: boolean;
  readonly inFlight: PollInFlight | null;
  /** Polls released as stalled whose results have not come back yet. */
  readonly stalled: readonly number[];
  /** Requests made during the in-flight poll, waiting for the next one. */
  readonly waiting: readonly number[];
  /** The armed cadence timer, by generation, or null. */
  readonly timer: number | null;
  readonly nextTimer: number;
  readonly nextGen: number;
  /** The newest poll whose native reads have returned. Decides `normal` vs `late`. */
  readonly newestFetched: number;
}

export interface PollConfig {
  readonly idleMs: number;
  readonly busyMs: number;
  /** How many stalled polls may be outstanding before no new one starts. */
  readonly maxStalled: number;
}

export type RequestOutcome = 'ok' | 'skipped' | 'stalled';
export type ApplyMode = 'normal' | 'late' | 'drop';

export type PairingPollEvent =
  | { readonly type: 'ready' }
  | { readonly type: 'foreground' }
  | { readonly type: 'background' }
  | { readonly type: 'rebindStart' }
  | { readonly type: 'rebindEnd' }
  | { readonly type: 'stop' }
  | { readonly type: 'busy'; readonly busy: boolean }
  | { readonly type: 'request'; readonly id: number }
  | { readonly type: 'tick'; readonly timer: number }
  /** A poll's native reads returned (or threw). */
  | { readonly type: 'fetched'; readonly gen: number }
  /** A poll's results have been applied: the poll is over. */
  | { readonly type: 'applied'; readonly gen: number }
  | { readonly type: 'stallTimer'; readonly gen: number };

export type PairingPollEffect =
  | { readonly type: 'startPoll'; readonly gen: number }
  | { readonly type: 'armStall'; readonly gen: number }
  | { readonly type: 'armTimer'; readonly timer: number; readonly delayMs: number }
  | { readonly type: 'cancelTimer'; readonly timer: number }
  | { readonly type: 'apply'; readonly gen: number; readonly mode: ApplyMode }
  | { readonly type: 'resolve'; readonly ids: readonly number[]; readonly outcome: RequestOutcome }
  | { readonly type: 'reportStalled'; readonly gen: number }
  | { readonly type: 'reportLate'; readonly gen: number };

export interface PairingPollStep {
  readonly state: PairingPollState;
  readonly effects: readonly PairingPollEffect[];
}

export const INITIAL_PAIRING_POLL: PairingPollState = Object.freeze({
  // The app starts on screen; the lifecycle reports only changes.
  gate: Object.freeze({ ready: false, foreground: true, rebinding: false, stopped: false }),
  busy: false,
  inFlight: null,
  stalled: Object.freeze([]) as readonly number[],
  waiting: Object.freeze([]) as readonly number[],
  timer: null,
  nextTimer: 1,
  nextGen: 1,
  newestFetched: 0,
});

export function canPoll(state: PairingPollState): boolean {
  const { gate } = state;
  return gate.ready && gate.foreground && !gate.rebinding && !gate.stopped;
}

function canStart(state: PairingPollState, config: PollConfig): boolean {
  return canPoll(state) && state.inFlight === null && state.stalled.length < config.maxStalled;
}

/** Accumulates effects while a transition is built, so every rule reads top to bottom. */
class Draft {
  effects: PairingPollEffect[] = [];
  constructor(
    public state: PairingPollState,
    private readonly config: PollConfig
  ) {}

  set(patch: Partial<PairingPollState>): void {
    this.state = { ...this.state, ...patch };
  }

  gate(patch: Partial<PollGate>): void {
    this.set({ gate: { ...this.state.gate, ...patch } });
  }

  cancelTimer(): void {
    if (this.state.timer === null) return;
    this.effects.push({ type: 'cancelTimer', timer: this.state.timer });
    this.set({ timer: null });
  }

  resolve(ids: readonly number[], outcome: RequestOutcome): void {
    if (ids.length > 0) this.effects.push({ type: 'resolve', ids: [...ids], outcome });
  }

  start(requests: readonly number[]): void {
    this.cancelTimer();
    const gen = this.state.nextGen;
    this.set({ inFlight: { gen, requests: [...requests] }, nextGen: gen + 1 });
    this.effects.push({ type: 'startPoll', gen }, { type: 'armStall', gen });
  }

  armTimer(): void {
    const timer = this.state.nextTimer;
    const delayMs = this.state.busy ? this.config.busyMs : this.config.idleMs;
    this.set({ timer, nextTimer: timer + 1 });
    this.effects.push({ type: 'armTimer', timer, delayMs });
  }

  /** Nothing in flight: serve whoever is waiting, or keep the cadence. */
  settle(): void {
    if (canStart(this.state, this.config) && this.state.waiting.length > 0) {
      const waiting = this.state.waiting;
      this.set({ waiting: [] });
      this.start(waiting);
      return;
    }
    if (this.state.inFlight === null && this.state.waiting.length > 0) {
      // Nothing running and nothing may start: too many polls are already stalled (a closed
      // gate has resolved these already). Waiting would be waiting on nothing.
      this.resolve(this.state.waiting, 'stalled');
      this.set({ waiting: [] });
    }
    if (canPoll(this.state) && this.state.inFlight === null && this.state.timer === null) {
      this.armTimer();
    }
  }

  /** The gate closed: no timer, and nobody may wait on a poll that will not come. */
  closed(): void {
    this.cancelTimer();
    this.resolve(this.state.waiting, 'skipped');
    this.set({ waiting: [] });
  }

  done(): PairingPollStep {
    return { state: this.state, effects: this.effects };
  }
}

export function stepPairingPoll(
  state: PairingPollState,
  event: PairingPollEvent,
  config: PollConfig
): PairingPollStep {
  const unchanged: PairingPollStep = { state, effects: [] };
  // Terminal: after `stop` only the completions of polls already running are absorbed.
  if (state.gate.stopped && event.type !== 'fetched' && event.type !== 'applied') {
    if (event.type === 'request') {
      return { state, effects: [{ type: 'resolve', ids: [event.id], outcome: 'skipped' }] };
    }
    return unchanged;
  }
  const d = new Draft(state, config);
  switch (event.type) {
    case 'ready':
      if (state.gate.ready) return unchanged;
      d.gate({ ready: true });
      d.settle();
      return d.done();
    case 'foreground':
      if (state.gate.foreground) return unchanged;
      d.gate({ foreground: true });
      // Close the gap rather than wait out a cadence: a pair that completed while we were away is
      // reconciled now. If a poll is somehow still running, the cadence resumes after it.
      if (canStart(d.state, config)) d.start([]);
      else d.settle();
      return d.done();
    case 'background':
      if (!state.gate.foreground) return unchanged;
      d.gate({ foreground: false });
      d.closed();
      return d.done();
    case 'rebindStart':
      if (state.gate.rebinding) return unchanged;
      d.gate({ rebinding: true });
      d.closed();
      return d.done();
    case 'rebindEnd':
      if (!state.gate.rebinding) return unchanged;
      d.gate({ rebinding: false });
      d.settle();
      return d.done();
    case 'stop': {
      d.gate({ stopped: true });
      d.closed();
      // Whoever the running poll was going to answer is answered now: a shutdown leaves no one
      // waiting. The poll itself is still absorbed when it lands.
      if (state.inFlight) {
        d.resolve(state.inFlight.requests, 'skipped');
        d.set({ inFlight: { gen: state.inFlight.gen, requests: [] } });
      }
      return d.done();
    }
    case 'busy':
      if (state.busy === event.busy) return unchanged;
      d.set({ busy: event.busy });
      return d.done();
    case 'request':
      if (!canPoll(state)) {
        d.resolve([event.id], 'skipped');
      } else if (state.inFlight) {
        d.set({ waiting: [...state.waiting, event.id] });
      } else if (!canStart(state, config)) {
        d.resolve([event.id], 'stalled');
      } else {
        d.start([event.id]);
      }
      return d.done();
    case 'tick':
      if (event.timer !== state.timer) return unchanged;
      d.set({ timer: null });
      if (canStart(d.state, config)) d.start([]);
      else d.settle();
      return d.done();
    case 'fetched': {
      const current = state.inFlight?.gen === event.gen;
      if (!current && !state.stalled.includes(event.gen)) return unchanged;
      const mode: ApplyMode = state.gate.stopped
        ? 'drop'
        : event.gen < state.newestFetched
          ? 'late'
          : 'normal';
      d.set({ newestFetched: Math.max(state.newestFetched, event.gen) });
      d.effects.push({ type: 'apply', gen: event.gen, mode });
      return d.done();
    }
    case 'applied':
      if (state.inFlight?.gen === event.gen) {
        d.resolve(state.inFlight.requests, 'ok');
        d.set({ inFlight: null });
        if (!state.gate.stopped) d.settle();
        return d.done();
      }
      if (state.stalled.includes(event.gen)) {
        d.set({ stalled: state.stalled.filter((gen) => gen !== event.gen) });
        d.effects.push({ type: 'reportLate', gen: event.gen });
        if (!state.gate.stopped) d.settle();
        return d.done();
      }
      return unchanged;
    case 'stallTimer':
      if (state.inFlight?.gen !== event.gen) return unchanged;
      d.effects.push({ type: 'reportStalled', gen: event.gen });
      d.resolve(state.inFlight.requests, 'stalled');
      d.set({ inFlight: null, stalled: [...state.stalled, event.gen] });
      d.settle();
      return d.done();
  }
}
