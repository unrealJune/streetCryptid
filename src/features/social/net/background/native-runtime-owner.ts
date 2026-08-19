/**
 * Process-wide ownership of the single native iroh runtime.
 *
 * The native module holds exactly one node per process (`self.node` in `IrohLocationModule.swift`),
 * and BOTH `createNode` and `shutdown` route through `clearRuntime()`, which nils it. Every other
 * native export guards on it and throws `NoNode: call createNode first` once it is gone.
 *
 * That makes "who owns the node" a process-wide invariant, not a per-service one — and getting it
 * wrong is silent and terminal. A second `LocationSharingService` (the short-lived headless one
 * expo-task-manager spins up) calling `createNode` mid-flight tears down the mounted runtime's node;
 * its `shutdown` in the session `finally` does it again. The mounted service keeps `status: 'ready'`
 * and a non-null `this.mod`, so nothing looks broken from JS — but from then on `readTrail` resolves
 * `[]` (it `.catch`es), `syncTrail` logs a warning and returns, `safeDocTicket` returns null, and
 * every button that reaches native throws into an error banner. The app renders, the map still pans
 * on the UI thread, and nothing works. Only a relaunch rebuilds a node — and if the same race runs
 * again on the next launch, the relaunch doesn't help either.
 *
 * `AppState.currentState` is NOT a sound signal for this. It is `'inactive'` (not `'active'`) during
 * a cold launch into the foreground and for as long as a system permission alert is up, so the old
 * `!== 'active'` test let a headless session start in exactly the two windows where the mounted
 * runtime is most likely to be building its node.
 *
 * This module is the explicit signal instead. It is deliberately a leaf — `location-sharing.ts`
 * imports it and so does `headless-runtime.ts`, which imports `location-sharing.ts`; keeping the
 * lock here is what stops that becoming a cycle.
 */

/** Set while a MOUNTED runtime owns the native node. Never claimed by a headless session. */
let claimed = false;

/**
 * Serializes every headless session against every other one, and lets a mounted runtime wait for an
 * in-flight session to finish rather than clobbering it.
 */
let sessionChain: Promise<void> = Promise.resolve();

/**
 * How long a session may hold the chain before the next one is allowed past it anyway.
 *
 * This exists because "absorb failures" is not the same as "absorb hangs". Chaining on a promise
 * that *rejects* is safe — the handlers below turn it into a resolved link. Chaining on one that
 * never *settles* is terminal: `sessionChain` never advances, every later session queues behind a
 * promise that will never resolve, and `awaitNativeRuntimeIdle` never returns, so the next mounted
 * launch hangs on the splash forever. Only killing the process clears it.
 *
 * That is not hypothetical. On 2026-08-18 an iPhone's headless refresh finished its work, flushed
 * telemetry, and then hung inside the native `shutdown` with a relay connection still open. The
 * phone went dark for 19 hours — every OS wake landed, queued, and did nothing — and the app hung
 * on launch until it was force-quit. See `headless-runtime.ts`.
 *
 * 90s is well clear of a healthy session (measured 6–15s including node build, sync and teardown)
 * and far short of the ~19h it actually cost. A session that overruns it is not cancelled — we
 * cannot cancel native work — it simply stops being everyone else's problem.
 */
export const NATIVE_RUNTIME_SESSION_WATCHDOG_MS = 90_000;

/** Notified when a session overruns the watchdog, so the overrun is reportable. */
export type SessionWatchdogHandler = (elapsedMs: number) => void;

let onWatchdog: SessionWatchdogHandler | null = null;

/**
 * Register the reporter for watchdog trips. Kept as a setter rather than a parameter so the leaf
 * module stays free of a telemetry import (see the header note about cycles).
 */
export function setNativeRuntimeSessionWatchdogHandler(
  handler: SessionWatchdogHandler | null
): void {
  onWatchdog = handler;
}

/**
 * The link that replaces {@link sessionChain}: resolves when `result` settles *or* when the
 * watchdog fires, whichever comes first. Both `result` handlers are attached unconditionally so a
 * rejected session never surfaces as an unhandled rejection.
 */
function advanceOn<T>(result: Promise<T>, watchdogMs: number): Promise<void> {
  if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    return result.then(
      () => undefined,
      () => undefined
    );
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      onWatchdog?.(watchdogMs);
      resolve();
    }, watchdogMs);
    // A pending watchdog must not hold the process (or a Jest run) open by itself. React Native's
    // timer has no `unref`, hence the optional call.
    (timer as unknown as { unref?: () => void }).unref?.();
    const settle = (): void => {
      clearTimeout(timer);
      resolve();
    };
    result.then(settle, settle);
  });
}

/**
 * Claim the native runtime for the mounted app. Called before `createNode`, so the claim is already
 * standing while the node is being built — the window a task callback is most likely to land in.
 */
export function claimNativeRuntime(): void {
  claimed = true;
}

/** Release the claim once the mounted runtime has torn its node down. */
export function releaseNativeRuntime(): void {
  claimed = false;
}

/** Whether a mounted runtime owns the node right now. */
export function isNativeRuntimeClaimed(): boolean {
  return claimed;
}

/**
 * Run `fn` with exclusive use of the native runtime, chained behind any session already running.
 *
 * Neither a failure nor a hang can wedge later sessions: a rejection is absorbed into the chain,
 * and a session still running after {@link NATIVE_RUNTIME_SESSION_WATCHDOG_MS} stops holding the
 * chain even though its own promise is still pending. The caller's promise is unaffected — it
 * still settles if and when `fn` does.
 */
export function withNativeRuntimeSession<T>(
  fn: () => Promise<T>,
  watchdogMs: number = NATIVE_RUNTIME_SESSION_WATCHDOG_MS
): Promise<T> {
  const result = sessionChain.then(fn);
  sessionChain = advanceOn(result, watchdogMs);
  return result;
}

/**
 * Resolve once any in-flight headless session has finished. The mounted runtime awaits this before
 * `createNode` so a session that started while we were still backgrounded gets to complete (and run
 * its `shutdown`) before we build the node it would otherwise nil out from under us.
 *
 * Bounded by the same watchdog as the chain itself, so this can no longer be the thing that hangs a
 * launch. Callers that block UI on it should still impose their own, tighter deadline — 90s of
 * splash screen is a bug of its own.
 */
export function awaitNativeRuntimeIdle(): Promise<void> {
  return sessionChain;
}

/** Test seam: drop the claim, the chain, and the watchdog reporter between cases. */
export function resetNativeRuntimeOwnerForTesting(): void {
  claimed = false;
  sessionChain = Promise.resolve();
  onWatchdog = null;
}
