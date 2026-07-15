import { AppState } from 'react-native';

import { createCryptidProfileStore } from '@/features/account/storage/profile-store';
import { LocationSharingService } from '../location-sharing';
import { backgroundOutbox } from './background-outbox';
import { getActiveBackfillHandler } from './register-task';

// Serialize ALL headless node usage. expo-task-manager delivers each OS callback to a fresh,
// short-lived JS context, and the native iroh runtime is a process-wide singleton (createNode →
// clearRuntime), so two overlapping headless sessions — a send-drain and a periodic backfill —
// would tear each other's node down mid-flight. One chained lock keeps them strictly sequential.
let sessionChain: Promise<void> = Promise.resolve();

interface HeadlessSession<T> {
  /** Cheap precondition checked BEFORE a node is spun up; `false` ⇒ skip and return `fallback`. */
  precheck?: () => Promise<boolean>;
  fallback: T;
  run: (service: LocationSharingService) => Promise<T>;
}

async function session<T>(opts: HeadlessSession<T>): Promise<T> {
  // Never run headless while the app is active: the mounted runtime owns the shared native node and
  // does this work itself. Spinning up a second node would call createNode → clearRuntime and tear
  // down the FOREGROUND node mid-flight (breaking its gossip subscription and pairing poll). The
  // batch is already persisted (senders enqueue before calling us), so nothing is lost — the
  // foreground engine flushes/syncs on its next cycle.
  if (AppState.currentState === 'active') return opts.fallback;
  if (opts.precheck && !(await opts.precheck())) return opts.fallback;

  const profile = await createCryptidProfileStore().load();
  if (!profile) {
    throw new Error('Cannot run background location work before a cryptid profile is configured.');
  }

  const service = new LocationSharingService();
  try {
    await service.init(profile.handle, profile.sigil, profile.cryptidName, profile.color, {
      mode: 'headless',
    });
    return await opts.run(service);
  } finally {
    // Drain telemetry before the node goes away — this short-lived context is exactly the one
    // whose batches die unexported if we skip it.
    await service.flushDevTelemetry();
    await service.shutdownAsync();
  }
}

/** Chain onto the shared lock so send-drain and backfill never spin up two native nodes at once. */
function runHeadless<T>(opts: HeadlessSession<T>): Promise<T> {
  const result = sessionChain.then(() => session(opts));
  sessionChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Publish queued fixes from a fresh headless context — the SEND path when the app is backgrounded or
 * killed. Called by the location TaskManager handler after it persists a batch. No-op while active
 * (the mounted runtime drains the outbox itself) or when nothing is queued.
 */
export function flushBackgroundOutboxHeadless(): Promise<number> {
  return runHeadless({
    precheck: async () => (await backgroundOutbox.pending()) > 0,
    fallback: 0,
    run: (service) =>
      backgroundOutbox.drain(async (fix) => {
        await service.publishFix(fix);
      }),
  });
}

/**
 * Periodic RECEIVE path: backfill fixes missed while backgrounded (from the trail-stash + peers),
 * then publish anything still queued. Driven by the `expo-background-task` scheduler — see
 * `backfill-task.ts`. No-op while the app is active (the foreground lifecycle already syncs).
 */
export function runBackgroundBackfillHeadless(): Promise<void> {
  // If a mounted runtime is alive it owns the process-wide native node. On Android that runtime
  // stays alive while backgrounded (the location foreground service), so `AppState` is NOT 'active'
  // and the `session()` guard alone would let us spin up a SECOND node here — whose `createNode`
  // calls `clearRuntime()` and tears the live node's subscriptions down, silently killing outgoing
  // publishes and live receive until relaunch. Route the backfill to the live runtime instead.
  const runMounted = getActiveBackfillHandler();
  if (runMounted) return runMounted();
  return runHeadless<void>({
    fallback: undefined,
    run: async (service) => {
      await service.syncTrail(0);
      if ((await backgroundOutbox.pending()) > 0) {
        await backgroundOutbox.drain(async (fix) => {
          await service.publishFix(fix);
        });
      }
    },
  });
}
