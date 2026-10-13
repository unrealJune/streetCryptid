/**
 * Owns the process's one location-sharing service and drives its startup lifecycle.
 *
 * This used to be module-scope variables inside `use-location-sharing.tsx` — the service, the init
 * latch, the lifecycle — and the decisions about them were split across the init effect, the
 * watchdog branch and a foreground listener. Each fix to that split (2026-09-18, 2026-10-03,
 * 2026-10-13) was a patch on one of the three. Here the decisions are the reducer's
 * (`core/service-lifecycle.ts`), this executes its effects, and none of it needs React, so the
 * retry, discard and late-landing behaviour is tested directly (`__tests__/service-supervisor.test.ts`).
 */
import {
  INITIAL_SERVICE_LIFECYCLE,
  stepServiceLifecycle,
  type ServiceLifecycle,
  type ServiceLifecycleEffect,
  type ServiceLifecycleEvent,
  type StallTrigger,
} from '@/features/social/core/service-lifecycle';
import { awaitInitBounded } from './background/init-watchdog';

/** What the supervisor needs of a service. `LocationSharingService` is one. */
export interface SupervisedService {
  /** Fire-and-forget teardown. Never awaited here: the init it abandons may itself be stuck. */
  shutdown(): void;
  currentInitPhase(): string | null;
  /** How long `init()` itself has been running, 0 before it starts. */
  initElapsedMs(): number;
}

export type AttemptResult =
  | { readonly outcome: 'ready' }
  | { readonly outcome: 'failed'; readonly error: unknown }
  /**
   * Outlived the watchdog. It is not cancelled — native work cannot be — and `landed` resolves
   * true if it later reaches `ready` as the attempt that is still current.
   */
  | { readonly outcome: 'timeout'; readonly landed: Promise<boolean> };

export interface StallNotice {
  readonly attempt: number;
  readonly trigger: StallTrigger;
  readonly initPhase: string | null;
  readonly elapsedMs: number;
}

export interface DiscardNotice {
  readonly attempt: number;
  readonly trigger: 'foreground' | 'user';
  /** What made it retryable. */
  readonly reason: 'init-timeout' | 'init-failed';
  readonly initPhase: string | null;
}

export interface ServiceSupervisorOptions<S extends SupervisedService> {
  readonly create: () => S;
  readonly watchdogMs: number;
  readonly now?: () => number;
  /** `app.init.timeout`. Called at most once per attempt. */
  readonly onStall?: (notice: StallNotice) => void;
}

interface InFlight<S> {
  readonly attempt: number;
  readonly service: S;
  readonly promise: Promise<void>;
}

export class ServiceSupervisor<S extends SupervisedService> {
  private current: S | null = null;
  private inFlight: InFlight<S> | null = null;
  private state: ServiceLifecycle = INITIAL_SERVICE_LIFECYCLE;
  private readonly lifecycleListeners = new Set<() => void>();
  private readonly discardListeners = new Set<(notice: DiscardNotice) => void>();

  constructor(private readonly options: ServiceSupervisorOptions<S>) {}

  /** The current service, built on first use and after every discard. */
  get service(): S {
    if (!this.current) this.current = this.options.create();
    return this.current;
  }

  get lifecycle(): ServiceLifecycle {
    return this.state;
  }

  /** For `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.lifecycleListeners.add(listener);
    return () => {
      this.lifecycleListeners.delete(listener);
    };
  };

  readonly getLifecycle = (): ServiceLifecycle => this.state;

  /** Told after a service was discarded, so a mounted provider can start the next attempt. */
  onDiscard(listener: (notice: DiscardNotice) => void): () => void {
    this.discardListeners.add(listener);
    return () => {
      this.discardListeners.delete(listener);
    };
  }

  /**
   * Join the attempt in flight, or begin one with `init`, and wait for it no longer than the
   * watchdog. A rejected attempt releases the latch, so a later caller begins a fresh one.
   */
  async attempt(init: (service: S) => Promise<void>): Promise<AttemptResult> {
    const service = this.service;
    if (!this.inFlight) {
      this.dispatch({ type: 'begin' });
      if (this.state.phase === 'ready') return { outcome: 'ready' };
      const attempt = this.state.attempt;
      const promise = Promise.resolve().then(() => init(service));
      this.inFlight = { attempt, service, promise };
      // Bookkeeping that belongs to the ATTEMPT, not to whichever caller is waiting on it — so an
      // init that lands after its watchdog still counts, and one that fails with nobody waiting
      // still says so.
      promise.then(
        () => this.dispatch({ type: 'ready', attempt }),
        (error: unknown) => {
          this.dispatch({
            type: 'failed',
            attempt,
            error: error instanceof Error ? error.message : String(error),
            initPhase: service.currentInitPhase(),
          });
          if (this.inFlight?.promise === promise) this.inFlight = null;
        }
      );
    }
    const { promise, attempt, service: owner } = this.inFlight!;
    const outcome = await awaitInitBounded(promise, this.options.watchdogMs);
    if (outcome === 'ready') return { outcome: 'ready' };
    if (outcome === 'failed') {
      return {
        outcome: 'failed',
        error: await promise.then(
          () => undefined,
          (e: unknown) => e
        ),
      };
    }
    this.dispatch({ type: 'watchdog', attempt, initPhase: owner.currentInitPhase() });
    return {
      outcome: 'timeout',
      landed: promise.then(
        () => this.state.attempt === attempt && this.state.phase === 'ready',
        () => false
      ),
    };
  }

  /**
   * The app came to the foreground: retry anything retryable, and judge an attempt in flight by the
   * clock, since the watchdog's timer may not have run while the app was in the background.
   * Returns whether the service was discarded.
   */
  foreground(): boolean {
    this.syncInitStarted();
    return this.dispatchForDiscard({
      type: 'foreground',
      now: this.now(),
      watchdogMs: this.options.watchdogMs,
      initPhase: this.current?.currentInitPhase() ?? null,
    });
  }

  /** Someone pressed retry. Returns whether the service was discarded. */
  retry(): boolean {
    return this.dispatchForDiscard({ type: 'retry' });
  }

  private dispatchForDiscard(event: ServiceLifecycleEvent): boolean {
    let discarded = false;
    this.dispatch(event, () => {
      discarded = true;
    });
    return discarded;
  }

  /** The service's own clock says when its `init()` started; the reducer needs to know too. */
  private syncInitStarted(): void {
    const service = this.current;
    if (!service || this.state.phase !== 'initializing' || this.state.initStartedAt !== null) {
      return;
    }
    const elapsed = service.initElapsedMs();
    if (elapsed <= 0) return;
    this.dispatch({ type: 'initStarted', attempt: this.state.attempt, at: this.now() - elapsed });
  }

  private dispatch(event: ServiceLifecycleEvent, onDiscarded?: () => void): void {
    const before = this.state;
    const step = stepServiceLifecycle(before, event);
    this.state = step.state;
    if (step.state !== before) this.lifecycleListeners.forEach((listener) => listener());
    for (const effect of step.effects) this.execute(effect, before, onDiscarded);
  }

  private execute(
    effect: ServiceLifecycleEffect,
    before: ServiceLifecycle,
    onDiscarded?: () => void
  ): void {
    switch (effect.type) {
      case 'reportStall':
        this.options.onStall?.({
          attempt: effect.attempt,
          trigger: effect.trigger,
          initPhase: effect.initPhase,
          elapsedMs: this.current?.initElapsedMs() ?? 0,
        });
        return;
      case 'discard': {
        const wedged = this.current;
        const notice: DiscardNotice = {
          attempt: effect.attempt,
          trigger: effect.trigger,
          reason: before.phase === 'failed' ? 'init-failed' : 'init-timeout',
          initPhase: before.initPhase ?? wedged?.currentInitPhase() ?? null,
        };
        this.current = null;
        this.inFlight = null;
        if (wedged) {
          try {
            // Fired and NOT awaited: the one thing we must not do is block recovery on the same
            // call that is already stuck (AGENTS.md: never `await` native teardown unbounded).
            wedged.shutdown();
          } catch {
            // A wedged service failing to start its own teardown is exactly the case this is for.
          }
        }
        onDiscarded?.();
        this.discardListeners.forEach((listener) => listener(notice));
        return;
      }
    }
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }
}
