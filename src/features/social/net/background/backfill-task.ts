import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';

/**
 * Periodic RECEIVE-side background task — the counterpart to the event-driven location SEND task in
 * `background-task.ts`. The OS location task only fires on movement and only PUBLISHES, so a
 * backgrounded phone never pulls friends' fixes that landed at the stash while it was asleep. This
 * registers an `expo-background-task` (iOS `BGTaskScheduler` / Android `WorkManager`) that
 * periodically wakes a short-lived headless node to backfill from the trail-stash + peers. It is a
 * deferrable, battery/network-gated task: the OS decides the exact cadence (≥ ~15 min) — there is
 * deliberately NO server push-wake. See docs/social/ARCHITECTURE.md §9.
 *
 * Both native modules are lazily + individually guarded (same pattern as `background-task.ts`), so
 * merely importing this file is side-effect-free and the feature degrades gracefully without them
 * (Expo Go, web, a dev client built before the package was added).
 */

let taskManagerMod: typeof import('expo-task-manager') | null | undefined;
let backgroundTaskMod: typeof import('expo-background-task') | null | undefined;

function tryTaskManager(): typeof import('expo-task-manager') | null {
  if (taskManagerMod !== undefined) return taskManagerMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    taskManagerMod = require('expo-task-manager') as typeof import('expo-task-manager');
  } catch {
    taskManagerMod = null;
  }
  return taskManagerMod;
}

function tryBackgroundTask(): typeof import('expo-background-task') | null {
  if (backgroundTaskMod !== undefined) return backgroundTaskMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load; see header
    backgroundTaskMod = require('expo-background-task') as typeof import('expo-background-task');
  } catch {
    backgroundTaskMod = null;
  }
  return backgroundTaskMod;
}

/** TaskManager task name for the periodic backfill. Must be stable across app launches. */
export const BACKGROUND_BACKFILL_TASK = 'streetcryptid.background-backfill';

/** Requested cadence. 15 min is the platform minimum; the OS throttles further as it sees fit. */
export const DEFAULT_BACKFILL_INTERVAL_MINUTES = 15;

/** True when both native modules needed for periodic backfill are present in this build. */
export function isBackgroundBackfillAvailable(): boolean {
  return tryTaskManager() !== null && tryBackgroundTask() !== null;
}

/**
 * Register the periodic backfill handler. Call once at module load (top level), passing the headless
 * runner that reconstructs a node from persistent storage and syncs. The runner must be
 * headless-safe (no closures over app state) and MUST flush telemetry before returning, or the OS
 * freezes the process with the batch unexported — so we flush here in `finally`.
 */
export function defineBackgroundBackfillTask(run: (parent?: SpanContext) => Promise<void>): void {
  const taskManager = tryTaskManager();
  const backgroundTask = tryBackgroundTask();
  if (!taskManager || !backgroundTask) return;
  taskManager.defineTask(BACKGROUND_BACKFILL_TASK, async () => {
    const telemetry = getTelemetry();
    // One span per OS-scheduled backfill — the receive-side counterpart of `bg.wake`.
    const span = telemetry.startSpan('bg.backfill');
    try {
      await run(span.context);
      span.setStatus('ok');
      return backgroundTask.BackgroundTaskResult.Success;
    } catch (err) {
      span.recordError(err);
      console.warn('[background-backfill] task failed', err);
      return backgroundTask.BackgroundTaskResult.Failed;
    } finally {
      span.end();
      // The OS may freeze this headless context the moment we return; unexported batches die with it.
      await telemetry.flush();
    }
  });
}

/** Ask the OS to run the backfill task periodically. Idempotent — re-registering just re-arms it. */
export async function scheduleBackgroundBackfill(
  minimumIntervalMinutes: number = DEFAULT_BACKFILL_INTERVAL_MINUTES
): Promise<void> {
  const backgroundTask = tryBackgroundTask();
  if (!backgroundTask) return;
  await backgroundTask.registerTaskAsync(BACKGROUND_BACKFILL_TASK, {
    minimumInterval: minimumIntervalMinutes,
  });
}

/** Cancel the periodic backfill task. Idempotent; safe when it was never scheduled. */
export async function cancelBackgroundBackfill(): Promise<void> {
  const taskManager = tryTaskManager();
  const backgroundTask = tryBackgroundTask();
  if (!taskManager || !backgroundTask) return;
  if (await taskManager.isTaskRegisteredAsync(BACKGROUND_BACKFILL_TASK)) {
    await backgroundTask.unregisterTaskAsync(BACKGROUND_BACKFILL_TASK);
  }
}
