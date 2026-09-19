/**
 * The bound on a mounted `init()`, and the shape of waiting for one.
 *
 * A leaf module so the hook's behaviour is testable without mounting React, and for the same
 * cycle-avoidance reason as `native-runtime-owner.ts` and `teardown-watermark.ts`.
 */

/**
 * How long a mounted `init()` may hold the shared latch before later waiters are let past it.
 *
 * The latch in `use-location-sharing.tsx` used to be cleared on rejection only, which is the
 * "absorb failures, but not hangs" hole `native-runtime-owner.ts` documents — chaining on a
 * promise that *rejects* is safe, chaining on one that never *settles* is terminal.
 *
 * That cost an iPhone nine hours on 2026-09-18. The OS froze the process 128 ms into a background
 * launch, mid-`init()` (no `cpu_resource` and no `JetsamEvent`, so it was frozen rather than
 * killed, and the container's newest write stayed at 00:36 all night). When the phone was picked
 * up at 09:57 the SAME JS context resumed, every mount awaited a promise that could never settle,
 * and `setServiceReady(true)` was never reached — the app drew its chrome and friend marker from
 * `hydrateFromStore()` and nothing else ever appeared. Only a force-quit cleared it.
 *
 * 30s is well clear of a healthy launch (node build, two permission prompts, a pairing poll) and
 * far short of the nine hours it actually cost. An init that overruns is NOT cancelled — we cannot
 * cancel native work — it simply stops being every future mount's problem.
 */
export const INIT_WATCHDOG_MS = 30_000;

export type InitOutcome = 'ready' | 'timeout' | 'failed';

/**
 * Await `init` but stop waiting after `watchdogMs`.
 *
 * Deliberately shaped like `advanceOn` in `native-runtime-owner.ts`: both handlers are attached
 * unconditionally so a rejected init never surfaces as an unhandled rejection, and the timer is
 * `unref`'d so a pending watchdog cannot hold the process (or a Jest run) open by itself.
 *
 * `failed` is reported rather than rethrown so the caller keeps its existing error handling; the
 * caller re-awaits the original promise to surface the real reason.
 */
export function awaitInitBounded(
  init: Promise<unknown>,
  watchdogMs: number = INIT_WATCHDOG_MS
): Promise<InitOutcome> {
  if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    return init.then(
      () => 'ready' as const,
      () => 'failed' as const
    );
  }
  return new Promise<InitOutcome>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), watchdogMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    init.then(
      () => {
        clearTimeout(timer);
        resolve('ready');
      },
      () => {
        clearTimeout(timer);
        resolve('failed');
      }
    );
  });
}
