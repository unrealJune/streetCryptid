import { Platform } from 'react-native';

import { backgroundOutbox } from './background-outbox';
import { defineBackgroundLocationTask, isBackgroundLocationAvailable } from './background-task';
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
  flushHeadless: async () => {
    const { flushBackgroundOutboxHeadless } = await import('./headless-runtime');
    await flushBackgroundOutboxHeadless();
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
    onBackgroundFixes: (fixes) => dispatcher.dispatch(fixes),
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
let activeBackfillHandler: (() => Promise<void>) | null = null;

/** Register the mounted runtime's backfill runner. Returns an unregister fn (last writer wins). */
export function registerActiveBackfillHandler(handler: () => Promise<void>): () => void {
  activeBackfillHandler = handler;
  return () => {
    if (activeBackfillHandler === handler) activeBackfillHandler = null;
  };
}

/** The mounted runtime's backfill runner, or null on a fresh headless launch (no runtime alive). */
export function getActiveBackfillHandler(): (() => Promise<void>) | null {
  return activeBackfillHandler;
}

if (Platform.OS !== 'web' && isBackgroundLocationAvailable()) {
  ensureBackgroundTaskRegistered();
}

if (Platform.OS !== 'web' && isBackgroundBackfillAvailable()) {
  // The periodic RECEIVE-side backfill task. Defined at module scope (like the location task) so a
  // fresh headless launch can run it; scheduling on/off is driven by startBackground/stopBackground.
  // The runner is lazily imported so this module's load stays light and headless-safe.
  defineBackgroundBackfillTask(async () => {
    const { runBackgroundBackfillHeadless } = await import('./headless-runtime');
    await runBackgroundBackfillHeadless();
  });
}
