import { Platform } from 'react-native';

import type { SpanContext } from '@/features/dev/telemetry';
import { backgroundOutbox } from './background-outbox';
import {
  defineAnchorGeofenceTask,
  defineBackgroundLocationTask,
  isBackgroundLocationAvailable,
} from './background-task';
import { defineBackgroundBackfillTask, isBackgroundBackfillAvailable } from './backfill-task';
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

// The mounted runtime's stationary-anchor exit handler. The geofence can fire into a headless
// context, but unlike the fix path there is nothing useful a headless launch can do on its own: the
// decision to resume continuous sampling belongs to the engine + cadence controller, which only
// exist while sharing is running. When no runtime is alive we simply re-arm location updates
// directly (below) and let the next mounted start reconcile.
let activeAnchorExitHandler: (() => Promise<void>) | null = null;

/** Register the mounted runtime's anchor-exit runner. Returns an unregister fn (last writer wins). */
export function registerActiveAnchorExitHandler(handler: () => Promise<void>): () => void {
  activeAnchorExitHandler = handler;
  return () => {
    if (activeAnchorExitHandler === handler) activeAnchorExitHandler = null;
  };
}

if (Platform.OS !== 'web' && isBackgroundLocationAvailable()) {
  ensureBackgroundTaskRegistered();

  // The stationary-anchor geofence. Defined at module scope like the location task so the OS can
  // relaunch us headless to deliver the exit. Inert unless `anchorWhenStationary` is enabled — with
  // it off no region is ever armed, so this handler simply never fires.
  defineAnchorGeofenceTask(async () => {
    const handler = activeAnchorExitHandler;
    if (handler) {
      await handler();
      return;
    }
    // No mounted runtime: the exit still proves the user moved, and leaving the hardware idle would
    // strand sharing until the app is next opened — the exact failure this whole mechanism risks.
    // Re-arm a plain moving cadence and let the next mounted start take over.
    const { startBackgroundLocation } = await import('./background-task');
    const { createSamplingPolicy } = await import('./sampling-policy');
    const { cfgFromDecision } = await import('./cadence-controller');
    const decision = createSamplingPolicy().decide({
      motion: 'walking',
      battery: { level: 1, charging: false, lowPower: false },
    });
    await startBackgroundLocation(
      cfgFromDecision(decision, 'walking', {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      })
    );
  });
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
