import { Platform } from 'react-native';

import {
  getTelemetry,
  type SpanContext,
  withEventLogLaunchContext,
} from '@/features/dev/telemetry';
import { createPersistentKV } from '../persistence';
import { stampWatermark } from './watermarks';

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

type BackgroundTaskModule = typeof import('expo-background-task');

let taskManagerMod: typeof import('expo-task-manager') | null | undefined;
let backgroundTaskMod: BackgroundTaskModule | null | undefined;

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

/**
 * Record that the OS ran us, before doing anything that could fail.
 *
 * The `bg.refresh` span below says the same thing, but only to a collector the phone can reach —
 * and a phone whose refresh has stopped is usually also a phone we are not hearing from. The
 * watermark is durable and local, so the NEXT `device.health` record carries `last_refresh_age_ms`
 * whenever the phone next manages to speak, which is the one number that separates "throttled into
 * silence" from "running fine and failing quietly". Stamped first for the same reason: a run that
 * throws still ran, and conflating that with never being scheduled is exactly the ambiguity this
 * exists to remove. Best-effort — a missed stamp costs one stale age and nothing else.
 */
async function stampRefresh(): Promise<void> {
  await stampWatermark(createPersistentKV(), 'refresh').catch(() => undefined);
}

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
  // When the refresh started, so an expiry can say how much window it actually got.
  let startedAt: number | null = null;
  armExpiryListener(backgroundTask, () => startedAt);
  taskManager.defineTask(BACKGROUND_REFRESH_TASK, () =>
    withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      // One span per OS-scheduled refresh — the periodic counterpart of `bg.wake`.
      const span = telemetry.startSpan('bg.refresh');
      startedAt = Date.now();
      await stampRefresh();
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
        startedAt = null;
        // The OS may freeze this headless context the moment we return; unexported batches die with it.
        await telemetry.flush();
      }
    })
  );
}

/**
 * Report a refresh the OS cut off before it finished.
 *
 * `BGTask.expirationHandler` is the only notice iOS gives that it is about to stop us, and until
 * now nothing listened to it — so a refresh that was terminated mid-flight was indistinguishable
 * from one that was never scheduled: both leave a `bg.refresh` span that simply never ends, and a
 * `last_refresh_age_ms` that climbs. Those want different fixes. One means the work is too big for
 * the window; the other means we are not being given windows at all.
 *
 * The flush is not optional and not deferrable. The OS is about to stop this process, so a span
 * left in the journal unexported dies describing the very thing it exists to describe — the same
 * rule every headless path in this codebase follows, at the one moment it is guaranteed to matter.
 *
 * `addExpirationListener` has shipped in expo-background-task since before this app used it; the
 * guard is for a bundle running against an older native module, per AGENTS.md's last rule.
 */
function armExpiryListener(
  backgroundTask: BackgroundTaskModule,
  startedAt: () => number | null
): void {
  if (typeof backgroundTask.addExpirationListener !== 'function') return;
  backgroundTask.addExpirationListener(() => {
    void withEventLogLaunchContext('background', async () => {
      const telemetry = getTelemetry();
      const began = startedAt();
      telemetry
        .startSpan('bg.refresh.expired', {
          attributes: {
            // How much window we actually got. `-1` means the expiry arrived with no refresh in
            // flight, which is worth seeing rather than reporting as zero elapsed.
            elapsed_ms: began === null ? -1 : Math.max(0, Date.now() - began),
            platform: Platform.OS,
            'sc.drop_reason': 'refresh-expired',
          },
        })
        .end();
      await telemetry.flush();
    });
  });
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
