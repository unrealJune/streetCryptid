import { Platform } from 'react-native';

import type { SpanContext } from '@/features/dev/telemetry';
import { backgroundOutbox } from './background-outbox';
import { defineBackgroundLocationTask, isBackgroundLocationAvailable } from './background-task';
import { defineBackgroundBackfillTask, isBackgroundBackfillAvailable } from './backfill-task';
import { defineReviveTask, isReviveFenceAvailable } from './revive-task';
import {
  createBackgroundFixDispatcher,
  type ActiveBackgroundFixHandler,
} from './background-dispatch';

/**
 * Wires the headless background-location task to a process-wide dispatcher.
 * A mounted runtime publishes immediately; a fresh TaskManager context stores
 * the batch durably, restores the persisted iroh identity/pool, and drains it.
 *
 * This module is imported by the app entry so `TaskManager.defineTask` runs in
 * global scope before React mounts, as required by Expo Location.
 *
 * The outbox is backed by expo-sqlite, so captures survive process death.
 */
export { backgroundOutbox } from './background-outbox';

let registered = false;
const dispatcher = createBackgroundFixDispatcher({
  outbox: backgroundOutbox,
  flushHeadless: async (parent) => {
    const { flushBackgroundOutboxHeadless } = await import('./headless-runtime');
    await flushBackgroundOutboxHeadless(parent);
  },
  onActiveError: (error) => {
    console.warn('[background-location] live publisher failed; fix queued for retry', error);
  },
});

/** Register the TaskManager handler exactly once. Safe to call repeatedly. */
export function ensureBackgroundTaskRegistered(): void {
  if (registered) return;
  registered = true;
  defineBackgroundLocationTask(() => ({
    onBackgroundFixes: (fixes, parent) => dispatcher.dispatch(fixes, parent),
  }));
}

/** Route TaskManager fixes through the mounted service while the app runtime is alive. */
export function registerActiveBackgroundFixHandler(
  handler: ActiveBackgroundFixHandler
): () => void {
  return dispatcher.registerActiveHandler(handler);
}

// The mounted runtime's RECEIVE-side backfill (syncTrail + outbox drain), registered while
// background sharing runs. The periodic backfill task routes here whenever a mounted runtime is
// alive so it reuses the live native node. On Android the mounted runtime stays alive while
// backgrounded (the location foreground service), so `AppState` is NOT 'active' and a headless
// backfill would call `createNode → clearRuntime()` — tearing the live node's subscriptions down
// and silently stopping outgoing publishes + live receive until the app is relaunched.
let activeBackfillHandler: ((parent?: SpanContext) => Promise<void>) | null = null;

/** Register the mounted runtime's backfill runner. Returns an unregister fn (last writer wins). */
export function registerActiveBackfillHandler(
  handler: (parent?: SpanContext) => Promise<void>
): () => void {
  activeBackfillHandler = handler;
  return () => {
    if (activeBackfillHandler === handler) activeBackfillHandler = null;
  };
}

/** The mounted runtime's backfill runner, or null on a fresh headless launch (no runtime alive). */
export function getActiveBackfillHandler(): ((parent?: SpanContext) => Promise<void>) | null {
  return activeBackfillHandler;
}

if (Platform.OS !== 'web' && isBackgroundLocationAvailable()) {
  ensureBackgroundTaskRegistered();
}

if (Platform.OS !== 'web' && isBackgroundBackfillAvailable()) {
  // The periodic RECEIVE-side backfill task. Defined at module scope (like the location task) so a
  // fresh headless launch can run it; scheduling on/off is driven by startBackground/stopBackground.
  // The runner is lazily imported so this module's load stays light and headless-safe.
  defineBackgroundBackfillTask(async (parent) => {
    const { runBackgroundBackfillHeadless } = await import('./headless-runtime');
    await runBackgroundBackfillHeadless(parent);
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
