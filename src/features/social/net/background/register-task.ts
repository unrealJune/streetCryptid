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
    onBackgroundFixes: (fixes) => dispatcher.dispatch(fixes),
  }));
}

/** Route TaskManager fixes through the mounted service while the app runtime is alive. */
export function registerActiveBackgroundFixHandler(
  handler: ActiveBackgroundFixHandler
): () => void {
  return dispatcher.registerActiveHandler(handler);
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
