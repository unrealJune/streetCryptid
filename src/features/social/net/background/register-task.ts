import { Platform } from 'react-native';

import type { SpanContext } from '@/features/dev/telemetry';
import { defineBackgroundRefreshTask, isBackgroundRefreshAvailable } from './refresh-task';
import { defineReviveTask, isReviveFenceAvailable } from './revive-task';

/**
 * Registers the OS task handlers that still exist on this side.
 *
 * Location capture is NOT one of them any more. It used to route an `expo-location` TaskManager
 * batch to a mounted runtime or a headless one; both are gone, because the thing that made the
 * whole arrangement necessary — needing a JS context to receive a fix — is what kept a Pixel from
 * publishing for eleven and a half hours. Capture and publish now happen in the native runtime
 * (`BackgroundLocationService` / `BackgroundLocationRuntime`), which does not need one.
 *
 * What remains are the two tasks that are still about JS work: the periodic refresh, which drives
 * the RECEIVE side, and the iOS revive fence.
 *
 * Imported by the app entry so `TaskManager.defineTask` runs in global scope before React mounts.
 */

// The mounted runtime's periodic refresh (heartbeat + outbox drain + current-fix sync), registered
// while background sharing runs. The periodic refresh task routes here whenever a mounted runtime is
// alive so it reuses the live native node. On Android the mounted runtime stays alive while
// backgrounded (the location foreground service), so `AppState` is NOT 'active' and a headless
// refresh would call `createNode → clearRuntime()` — tearing the live node's subscriptions down
// and silently stopping outgoing publishes + live receive until the app is relaunched.
let activeRefreshHandler: ((parent?: SpanContext) => Promise<void>) | null = null;

/** Register the mounted runtime's refresh runner. Returns an unregister fn (last writer wins). */
export function registerActiveRefreshHandler(
  handler: (parent?: SpanContext) => Promise<void>
): () => void {
  activeRefreshHandler = handler;
  return () => {
    if (activeRefreshHandler === handler) activeRefreshHandler = null;
  };
}

/** The mounted runtime's refresh runner, or null on a fresh headless launch (no runtime alive). */
export function getActiveRefreshHandler(): ((parent?: SpanContext) => Promise<void>) | null {
  return activeRefreshHandler;
}

if (Platform.OS !== 'web' && isBackgroundRefreshAvailable()) {
  // The periodic refresh task. Defined at module scope (like the location task) so a
  // fresh headless launch can run it; scheduling on/off is driven by startBackground/stopBackground.
  // The runner is lazily imported so this module's load stays light and headless-safe.
  defineBackgroundRefreshTask(async (parent) => {
    const { runBackgroundRefreshHeadless } = await import('./headless-runtime');
    await runBackgroundRefreshHeadless(parent);
  });
}

if (isReviveFenceAvailable()) {
  // The iOS revive tripwire. Also defined at module scope — more so than the others, since the whole
  // point is to be serviceable from a COLD launch that Core Location triggered, where nothing else
  // in the app has run yet. Crossing the fence means the phone moved a couple of blocks since we
  // last armed: re-arm location updates if we were killed, then re-center the fence on where we are
  // now so it keeps following the user.
  // Only genuine `Exit` events reach this runner — `defineReviveTask` drops the synthetic
  // state-determination callback that every arm produces on iOS, which is what previously turned
  // "re-center at the end of the handler" into unbounded recursion.
  defineReviveTask(async (parent) => {
    const { ensureSharingArmedHeadless } = await import('./headless-runtime');
    await ensureSharingArmedHeadless('geofence', parent);
    try {
      const { armReviveFence, REVIVE_FENCE_MAX_FIX_AGE_MS } = await import('./revive-task');
      const Location = await import('expo-location');
      // `maxAge` matters: an unconstrained read hands back whatever Core Location last cached,
      // however old. Re-centering on a dead fix plants the fence where we are not, and being
      // permanently outside it is the one thing that still re-fires a real exit on every arm.
      const pos = await Location.getLastKnownPositionAsync({
        maxAge: REVIVE_FENCE_MAX_FIX_AGE_MS,
      });
      if (pos) {
        await armReviveFence({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? 0,
          headingDeg: pos.coords.heading ?? 0,
          ts: pos.timestamp,
        });
      }
    } catch (error) {
      // A fence we failed to re-center still covers the old location, so the tripwire survives.
      console.warn('[revive-fence] re-center failed', error);
    }
  });
}
