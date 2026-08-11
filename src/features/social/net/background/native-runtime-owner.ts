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
 * Failures are absorbed into the chain so one broken session cannot wedge every later one.
 */
export function withNativeRuntimeSession<T>(fn: () => Promise<T>): Promise<T> {
  const result = sessionChain.then(fn);
  sessionChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Resolve once any in-flight headless session has finished. The mounted runtime awaits this before
 * `createNode` so a session that started while we were still backgrounded gets to complete (and run
 * its `shutdown`) before we build the node it would otherwise nil out from under us.
 */
export function awaitNativeRuntimeIdle(): Promise<void> {
  return sessionChain;
}

/** Test seam: drop the claim and the chain between cases. */
export function resetNativeRuntimeOwnerForTesting(): void {
  claimed = false;
  sessionChain = Promise.resolve();
}
