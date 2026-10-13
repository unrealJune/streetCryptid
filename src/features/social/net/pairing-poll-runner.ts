/**
 * Executes the pairing-poll state machine (`core/pairing-poll-driver.ts`).
 *
 * Everything that decides lives in the driver; this only turns its effects into timers and calls,
 * and callbacks back into events. Timers and the poll itself are injected, so the runner is
 * testable with fake timers and a fake poll, and the service's races are tested through it.
 */
import {
  INITIAL_PAIRING_POLL,
  stepPairingPoll,
  type ApplyMode,
  type PairingPollEffect,
  type PairingPollEvent,
  type PairingPollState,
  type PollConfig,
  type RequestOutcome,
} from '@/features/social/core/pairing-poll-driver';

export type FetchResult<R> = { ok: true; value: R } | { ok: false; error: unknown };

export interface PairingPollRunnerOptions<R> {
  readonly config: PollConfig;
  /** How long a poll may run before it is reported and released. */
  readonly stallMs: number;
  /** The native reads. May throw; the error is handed to `apply`. */
  readonly fetch: (gen: number) => Promise<R>;
  /**
   * Apply one poll's results. Called for every poll whose reads returned, in every mode — `drop`
   * included, so the caller can close whatever it opened in `fetch` — and never concurrently for
   * the same gen. A throw is swallowed: the poll is over either way.
   */
  readonly apply: (result: FetchResult<R>, mode: ApplyMode, gen: number) => Promise<void>;
  /** Whether a session is live or Bump is armed, read before every event. */
  readonly isBusy: () => boolean;
  readonly onStalled?: (gen: number) => void;
  readonly onLate?: (gen: number) => void;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class PairingPollRunner<R> {
  private state: PairingPollState = INITIAL_PAIRING_POLL;
  private readonly waiters = new Map<number, (outcome: RequestOutcome) => void>();
  private readonly cadence = new Map<number, unknown>();
  private readonly stallTimers = new Map<number, unknown>();
  private readonly results = new Map<number, FetchResult<R>>();
  private nextRequest = 1;
  /** Events raised while effects run are queued, so a transition never runs inside another. */
  private readonly queue: PairingPollEvent[] = [];
  private dispatching = false;

  constructor(private readonly options: PairingPollRunnerOptions<R>) {}

  /** The driver's state. For tests and diagnostics; never mutate. */
  get current(): PairingPollState {
    return this.state;
  }

  ready(): void {
    this.dispatch({ type: 'ready' });
  }

  foreground(): void {
    this.dispatch({ type: 'foreground' });
  }

  background(): void {
    this.dispatch({ type: 'background' });
  }

  rebindStart(): void {
    this.dispatch({ type: 'rebindStart' });
  }

  rebindEnd(): void {
    this.dispatch({ type: 'rebindEnd' });
  }

  stop(): void {
    this.dispatch({ type: 'stop' });
  }

  /**
   * Ask for a poll that starts after now. Resolves when it has been applied (`ok`), at once when
   * the gate is closed (`skipped`), or when the poll serving it stalled (`stalled`). Never hangs.
   */
  request(): Promise<RequestOutcome> {
    const id = this.nextRequest++;
    const answered = new Promise<RequestOutcome>((resolve) => this.waiters.set(id, resolve));
    this.dispatch({ type: 'request', id });
    return answered;
  }

  private dispatch(event: PairingPollEvent): void {
    this.queue.push(event);
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.transition({ type: 'busy', busy: this.options.isBusy() });
        this.transition(next);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private transition(event: PairingPollEvent): void {
    const step = stepPairingPoll(this.state, event, this.options.config);
    this.state = step.state;
    for (const effect of step.effects) this.run(effect);
  }

  private run(effect: PairingPollEffect): void {
    switch (effect.type) {
      case 'startPoll':
        void this.poll(effect.gen);
        return;
      case 'armStall':
        this.stallTimers.set(
          effect.gen,
          this.setTimer(() => {
            this.stallTimers.delete(effect.gen);
            this.dispatch({ type: 'stallTimer', gen: effect.gen });
          }, this.options.stallMs)
        );
        return;
      case 'armTimer':
        this.cadence.set(
          effect.timer,
          this.setTimer(() => {
            this.cadence.delete(effect.timer);
            this.dispatch({ type: 'tick', timer: effect.timer });
          }, effect.delayMs)
        );
        return;
      case 'cancelTimer': {
        const handle = this.cadence.get(effect.timer);
        this.cadence.delete(effect.timer);
        if (handle !== undefined) this.clearTimer(handle);
        return;
      }
      case 'apply':
        void this.applyAndFinish(effect.gen, effect.mode);
        return;
      case 'resolve':
        for (const id of effect.ids) {
          const resolve = this.waiters.get(id);
          this.waiters.delete(id);
          resolve?.(effect.outcome);
        }
        return;
      case 'reportStalled':
        this.options.onStalled?.(effect.gen);
        return;
      case 'reportLate':
        this.options.onLate?.(effect.gen);
        return;
    }
  }

  private async poll(gen: number): Promise<void> {
    let result: FetchResult<R>;
    try {
      result = { ok: true, value: await this.options.fetch(gen) };
    } catch (error) {
      result = { ok: false, error };
    }
    this.results.set(gen, result);
    this.dispatch({ type: 'fetched', gen });
  }

  private async applyAndFinish(gen: number, mode: ApplyMode): Promise<void> {
    const result = this.results.get(gen);
    this.results.delete(gen);
    if (result) {
      try {
        await this.options.apply(result, mode, gen);
      } catch {
        // The poll is over either way; `apply` reports its own errors.
      }
    }
    const stall = this.stallTimers.get(gen);
    this.stallTimers.delete(gen);
    if (stall !== undefined) this.clearTimer(stall);
    this.dispatch({ type: 'applied', gen });
  }

  private setTimer(fn: () => void, ms: number): unknown {
    if (this.options.setTimer) return this.options.setTimer(fn, ms);
    const handle = setTimeout(fn, ms);
    // Don't keep the Node event loop (jest / tooling) alive on our account; no-op in RN/Hermes.
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  }

  private clearTimer(handle: unknown): void {
    if (this.options.clearTimer) this.options.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}
