import {
  getTelemetry,
  type SpanContext,
  withEventLogLaunchContext,
} from '@/features/dev/telemetry';

/**
 * Periodic background refresh — the counterpart to the event-driven location SEND task in
 * `background-task.ts`. The OS location task only fires on movement, so without this a stationary
 * backgrounded phone neither publishes a heartbeat nor picks up friends' current positions. This
 * registers an `expo-background-task` (iOS `BGTaskScheduler` / Android `WorkManager`) that
 * periodically wakes to heartbeat, drain the outbox, and reconcile the current fix with the
 * trail-stash + peers. It is a deferrable, battery/network-gated task: the OS decides the exact
 * cadence (≥ ~15 min) — there is deliberately NO server push-wake.
 * See docs/social/ARCHITECTURE.md §9.
 *
 * This task does NOT recover history. The durable path is last-write-wins
 * (docs/social/FORWARD-SECRECY.md §4.4): a reconciliation moves each author's *current* fix and
 * nothing behind it. It is also the backstop that re-arms sharing on iOS after a process kill —
 * see `ensureSharingArmedHeadless`.
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
export const BACKGROUND_REFRESH_TASK = 'streetcryptid.background-refresh';

/** Requested cadence. 15 min is the platform minimum; the OS throttles further as it sees fit. */
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 15;

/** True when both native modules needed for the periodic refresh are present in this build. */
export function isBackgroundRefreshAvailable(): boolean {
  return tryTaskManager() !== null && tryBackgroundTask() !== null;
}

/**
 * Register the periodic refresh handler. Call once at module load (top level), passing the headless
 * runner that reconstructs a node from persistent storage and syncs. The runner must be
 * headless-safe (no closures over app state) and MUST flush telemetry before returning, or the OS
 * freezes the process with the batch unexported — so we flush here in `finally`.
 */
export function defineBackgroundRefreshTask(run: (parent?: SpanContext) => Promise<void>): void {
  const taskManager = tryTaskManager();
  const backgroundTask = tryBackgroundTask();
  if (!taskManager || !backgroundTask) return;
  taskManager.defineTask(BACKGROUND_REFRESH_TASK, () =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      // One span per OS-scheduled refresh — the periodic counterpart of `bg.wake`.
      const span = telemetry.startSpan('bg.refresh');
      try {
        await run(span.context);
        span.setStatus('ok');
        return backgroundTask.BackgroundTaskResult.Success;
      } catch (err) {
        span.recordError(err);
        console.warn('[background-refresh] task failed', err);
        return backgroundTask.BackgroundTaskResult.Failed;
      } finally {
        span.end();
        // The OS may freeze this headless context the moment we return; unexported batches die with it.
        await telemetry.flush();
      }
    })
  );
}

/** Ask the OS to run the refresh task periodically. Idempotent — re-registering just re-arms it. */
export async function scheduleBackgroundRefresh(
  minimumIntervalMinutes: number = DEFAULT_REFRESH_INTERVAL_MINUTES
): Promise<void> {
  const backgroundTask = tryBackgroundTask();
  if (!backgroundTask) return;
  await backgroundTask.registerTaskAsync(BACKGROUND_REFRESH_TASK, {
    minimumInterval: minimumIntervalMinutes,
  });
}

/** Cancel the periodic refresh task. Idempotent; safe when it was never scheduled. */
export async function cancelBackgroundRefresh(): Promise<void> {
  const taskManager = tryTaskManager();
  const backgroundTask = tryBackgroundTask();
  if (!taskManager || !backgroundTask) return;
  if (await taskManager.isTaskRegisteredAsync(BACKGROUND_REFRESH_TASK)) {
    await backgroundTask.unregisterTaskAsync(BACKGROUND_REFRESH_TASK);
  }
}
