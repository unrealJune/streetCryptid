import type { IrohLocationNativeModule, TransportConfig } from 'iroh-location';

import { getTelemetry } from '@/features/dev/telemetry';

/**
 * The JS side of the native node's lifecycle: starting it, bounded, and — on binaries from before
 * the node host — prising the stores back from the native background runtime.
 *
 * Pulled out of `location-sharing.ts` because it is the one part of that file whose contract is
 * entirely about the BRIDGE, and it was the part that failed on 2026-10-03: a refused start, a
 * handover that did nothing on Android, a single retry refused identically. Each function here
 * takes the module as an argument, so the rules can be tested against a fake that refuses, hangs or
 * lacks an export on demand (`__tests__/native-node.test.ts`).
 *
 * On a binary with a node host (`hasNodeHost`) most of this is dormant by construction: there is
 * one node per process, so a start is never refused and there is nothing to hand over. It stays
 * because a phone can run an older binary than the JS bundle.
 */

/**
 * How long a launch waits for the native node to start before giving up on it.
 *
 * Deliberately well above the native bounds it backstops (BLE attach 10 s + endpoint bind 30 s),
 * because it is not a competing deadline — it is the guard for a binary that does not have them.
 * A phone can be running an older `.so`/XCFramework than the JS bundle, and on 2026-09-13 exactly
 * that combination (unbounded `ble::attach`, awaited under the node lock) left an iPhone dark for
 * 13 h and then hung the splash screen on relaunch, with no span or log to say why.
 *
 * On expiry the launch FAILS rather than continuing: the native call is still running — JS cannot
 * cancel it — so there is no node, and a service that pretends otherwise publishes nothing while
 * reporting itself ready. An error the user can retry is the honest outcome.
 */
export const NATIVE_START_TIMEOUT_MS = 60_000;

/**
 * How long the native runtime may take to give the Rust stores back before the app stops waiting.
 *
 * Sized against the same measurements as `NATIVE_RUNTIME_SESSION_WATCHDOG_MS`: a healthy native
 * shutdown is well under a second, and a whole headless session including node build, sync and
 * teardown measured 6-15s. Five seconds is generous for a shutdown alone and short enough that a
 * user opening the app does not sit on a splash screen wondering. An overrun is not fatal — the
 * app tries to start anyway and `startNativeBounded` retries once.
 */
export const NATIVE_HANDOVER_TIMEOUT_MS = 5_000;

type NativeModule = Pick<
  IrohLocationNativeModule,
  'start' | 'handOverNativeBackground' | 'releaseNativeBackground' | 'stopNativeBackground'
> &
  Partial<Pick<IrohLocationNativeModule, 'restartNode'>>;

/**
 * Whether this binary runs one node per process through the Rust node host. `restartNode` ships
 * exactly with the host, so it is the capability probe.
 */
export function hasNodeHost(mod: Partial<Pick<IrohLocationNativeModule, 'restartNode'>>): boolean {
  return typeof mod.restartNode === 'function';
}

/**
 * Whether a native `start` failure is the store claim being held by the other half of the process.
 *
 * Matched on the message because that is all `LocationError` gives us across the bridge. Kept
 * deliberately loose: the exact wording comes from `durable.rs` and is not a contract.
 */
export function isClaimRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /already open|already claimed|writer claim|AlreadyOpen/i.test(message);
}

export interface StartDeps {
  /** Persist and ship telemetry: the start may be about to be frozen by the OS. */
  flush(): Promise<void>;
  /** Take the stores back from the native runtime before the one retry. */
  handOver(): Promise<void>;
}

/**
 * `mod.start()`, bounded — see {@link NATIVE_START_TIMEOUT_MS}.
 *
 * Emits `node.start_timeout` on expiry. That span is the whole point of the bound: a native
 * start that never returns is otherwise completely silent, because every span the launch would
 * have emitted is downstream of the call that is stuck.
 *
 * A start refused by the store claim (`node.start.claim_refused`) hands over and retries ONCE —
 * once, not in a loop: a loop would be the 2026-09-16 construction storm in a different costume.
 */
export async function startNativeBounded(
  mod: NativeModule,
  config: TransportConfig,
  deps: StartDeps,
  attempt = 0
): Promise<void> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), NATIVE_START_TIMEOUT_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  try {
    const outcome = await Promise.race([
      mod.start(config).then(() => 'started' as const),
      deadline,
    ]);
    if (outcome === 'timeout') {
      getTelemetry()
        .startSpan('node.start_timeout', {
          attributes: {
            'node.start_wait_ms': Date.now() - startedAt,
            'sc.drop_reason': 'native-start-timeout',
          },
        })
        .end();
      // Flush explicitly: on a headless wake the OS may freeze us the moment this rejects, and
      // this span is the only record that the start is still stuck in native code.
      await deps.flush().catch(() => undefined);
      throw new Error(`native start did not return within ${NATIVE_START_TIMEOUT_MS}ms`);
    }
  } catch (error) {
    if (attempt === 0 && isClaimRefusal(error)) {
      getTelemetry()
        .startSpan('node.start.claim_refused', {
          attributes: { attempt, 'sc.drop_reason': 'native-claim-refused' },
        })
        .end();
      clearTimeout(timer);
      await deps.handOver();
      return startNativeBounded(mod, config, deps, attempt + 1);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the native runtime to give the Rust stores back, bounded on both sides. LEGACY: only
 * binaries from before the node host export it.
 *
 * Bounded twice on purpose. The native side races the shutdown against its own timeout so the
 * promise always settles whatever Rust does — AGENTS.md's rule is about a promise that never
 * settles, as distinct from one that rejects. This side bounds it again because a native call
 * that never returns is still a native call that never returns.
 *
 * Never throws. A handover we could not complete is reported and then proceeded past: the claim
 * may well be free anyway, and `startNativeBounded` retries once on `AlreadyOpen`. Without the
 * export this falls back to {@link releaseNativeBackground} — which on a pre-host Android binary
 * frees nothing at all, which is how one could be refused its own stores (2026-10-03), and which on
 * a host binary is exactly right, because there is nothing to free.
 */
export async function handOverNativeBackground(mod: NativeModule | null): Promise<void> {
  if (typeof mod?.handOverNativeBackground !== 'function') {
    releaseNativeBackground(mod);
    return;
  }
  const span = getTelemetry().startSpan('node.handover');
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      mod.handOverNativeBackground(NATIVE_HANDOVER_TIMEOUT_MS),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), NATIVE_HANDOVER_TIMEOUT_MS * 2);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
    span.setAttributes({ completed, waited_ms: Date.now() - started });
    if (!completed) span.setAttribute('sc.drop_reason', 'handover-timeout');
    span.setStatus('ok');
  } catch (error) {
    // An older binary, or a native call that threw. Either way the app still has to try to start.
    span.recordError(error);
  } finally {
    clearTimeout(timer);
    span.end();
  }
}

/**
 * This JS runtime is going away (or taking over), and captures should stop being handed to it.
 *
 * Falls back to the full stop on a binary that predates `releaseNativeBackground`, because on
 * Android leaving a foreground service running with no JS and no way to reach it is worse than
 * disarming, and on iOS the old behaviour is what that binary has always done. Never throws.
 */
export function releaseNativeBackground(mod: NativeModule | null): void {
  try {
    if (typeof mod?.releaseNativeBackground === 'function') mod.releaseNativeBackground();
    else mod?.stopNativeBackground?.();
  } catch (err) {
    getTelemetry().log('warn', 'native background release failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}
