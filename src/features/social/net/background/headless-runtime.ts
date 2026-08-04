import { AppState, Platform, type AppStateStatus } from 'react-native';

import { getTelemetry, type SpanContext } from '@/features/dev/telemetry';
import { createCryptidProfileStore } from '@/features/account/storage/profile-store';
import { LocationSharingService } from '../location-sharing';
import { createPersistentKV, loadShareIntervalMs, loadSharingEnabled } from '../persistence';
import { backgroundOutbox } from './background-outbox';
import { isBackgroundLocationRunning, startBackgroundLocation } from './background-task';
import { createBatterySource } from './battery-source';
import { cfgFromDecision } from './cadence-controller';
import { getActiveBackfillHandler } from './register-task';
import { createSamplingPolicy } from './sampling-policy';

// Serialize ALL headless node usage. expo-task-manager delivers each OS callback to a fresh,
// short-lived JS context, and the native iroh runtime is a process-wide singleton (createNode →
// clearRuntime), so two overlapping headless sessions — a send-drain and a periodic backfill —
// would tear each other's node down mid-flight. One chained lock keeps them strictly sequential.
let sessionChain: Promise<void> = Promise.resolve();

/**
 * How long to wait for `AppState` to settle before assuming a launch is a foreground one. Paid at
 * most once per cold launch, and only while the state is genuinely ambiguous.
 */
const APP_STATE_SETTLE_MS = 2_000;

/**
 * Resolve whether this process is a background wake or a foreground launch.
 *
 * `AppState.currentState` on its own cannot answer that at launch. RN seeds it from
 * `initialAppState`, captured while `UIApplication.applicationState` is still `.inactive` in
 * `didFinishLaunching` — so for the first moments of every cold launch it reads `'inactive'`, never
 * `'active'`. And a cold launch is exactly when the location task fires: `EXTaskService` restores
 * the task in `didFinishLaunchingWithOptions`, and every event queued before `defineTask` ran is
 * replayed the moment JS starts observing, which is module-eval time — before React has mounted, so
 * the dispatcher's `activeHandler` is null as well. Both signals therefore say "headless" while the
 * app is in fact booting into the foreground.
 *
 * That combination is the force-quit-then-relaunch freeze. A second {@link LocationSharingService}
 * was constructed here, its `createNode` called `IrohLocationModule.clearRuntime()` and its
 * `finally` called `shutdownAsync()` → `node = nil`, tearing down the node
 * `LocationSharingProvider` was concurrently building — and pointing a second iroh store at the same
 * `data_dir`. The provider's init then never settled, so `CryptidAccountGate` /
 * `LocationDisclosureGate` stayed on their blank loading view: no map, no controls, nothing to tap.
 * It reproduces only from a cold start because a resume re-evaluates no module scope, replays no
 * queued events, and already reads `'active'`.
 *
 * A real background wake is unambiguous — iOS reports `.background` when it relaunches or resumes a
 * terminated app for a location or geofence event, and Android's headless context likewise — so only
 * the launch transition needs waiting out, and it resolves itself within a tick or two. Timing out
 * resolves to `'active'` deliberately: skipping the work costs a delayed publish (the batch is
 * already durable in the outbox, and the mounted runtime drains it on its first fix), while guessing
 * wrong in the other direction costs the whole app.
 */
function settledAppState(): Promise<AppStateStatus> {
  const current = AppState.currentState;
  if (current === 'active' || current === 'background') return Promise.resolve(current);
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (next: AppStateStatus): void => {
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove();
      resolve(next);
    };
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' || next === 'background') settle(next);
    });
    timer = setTimeout(() => settle('active'), APP_STATE_SETTLE_MS);
  });
}

interface HeadlessSession<T> {
  /** Cheap precondition checked BEFORE a node is spun up; `false` ⇒ skip and return `fallback`. */
  precheck?: () => Promise<boolean>;
  fallback: T;
  run: (service: LocationSharingService) => Promise<T>;
}

async function session<T>(opts: HeadlessSession<T>): Promise<T> {
  // Only ever run from a genuine background wake: the mounted runtime owns the shared native node
  // and does this work itself. Spinning up a second node would call createNode → clearRuntime and
  // tear down the FOREGROUND node mid-flight (breaking its gossip subscription and pairing poll).
  // The batch is already persisted (senders enqueue before calling us), so nothing is lost — the
  // foreground engine flushes/syncs on its next cycle. `settledAppState` rather than
  // `AppState.currentState`, because at cold launch the latter has not answered the question yet.
  if ((await settledAppState()) !== 'background') return opts.fallback;
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

/** What woke us. Recorded on the span, because the trigger decides whether we are even allowed. */
export type SelfHealTrigger = 'backfill' | 'geofence';

/**
 * Re-arm OS background location updates if the user wants sharing on but the OS task is not running.
 *
 * This is the self-heal, and it exists because the ordinary re-arm path is unreachable from here:
 * `rearmBackgroundLocationTask` is only called via `startBackground`, which is driven by a React
 * hook, so it needs the UI to mount. A phone that was terminated can therefore be woken repeatedly —
 * for a backfill, for a geofence exit — sync happily, and still never restart its own location
 * reporting. That is exactly what kept an iPhone dark for hours after a live-mode test killed it.
 *
 * ## It is a safety net, not the primary mechanism — especially on Android
 * Both platforms already restore sharing on their own in the common cases, and this must not be
 * mistaken for what is holding them up:
 *  - **Android reboot** is handled by expo-task-manager's `TaskBroadcastReceiver`, which is
 *    registered for `BOOT_COMPLETED`; constructing its `TaskService` calls `restoreTasks()`, which
 *    re-registers the persisted location task, and `LocationTaskConsumer.didRegister` restarts
 *    location updates. `RECEIVE_BOOT_COMPLETED` is declared in `app.json`, and `location` is not one
 *    of the FGS types Android 15 bars from a `BOOT_COMPLETED` receiver. This path needs nothing
 *    from us.
 *  - **Android process kill** is handled by `LocationTaskService` returning `START_REDELIVER_INTENT`
 *    — the system restarts the service unaided.
 *  - **iOS** has no equivalent of either, which is why the geofence tripwire exists there.
 *
 * So on Android this only covers the residue: sharing enabled in our own persisted state while the
 * OS task is somehow not running. It is still worth attempting — if the user has turned off battery
 * optimisation it simply succeeds — but a `fgs-start-blocked` here is an expected outcome on a
 * `backfill` trigger, not an alarm. From a `geofence` trigger it should succeed, because a geofence
 * transition is on Android's exemption list for starting a foreground service from the background.
 *
 * Deliberately NOT wrapped in {@link runHeadless}: it touches only the OS location task, needs no
 * iroh node, and so cannot trip the `createNode → clearRuntime` singleton hazard described above.
 * That also makes it safe to call while a mounted runtime is alive.
 *
 * @returns true when it actually re-armed (for telemetry/tests), false when nothing was needed.
 */
export async function ensureSharingArmedHeadless(
  trigger: SelfHealTrigger,
  parent?: SpanContext
): Promise<boolean> {
  const kv = createPersistentKV();
  if (!(await loadSharingEnabled(kv))) return false;
  // Not a fallback for the platform's own restore — if the OS already brought the task back (boot
  // receiver, START_REDELIVER_INTENT), there is nothing to do and nothing to report.
  if (await isBackgroundLocationRunning()) return false;

  const span = getTelemetry().startSpan('bg.selfheal', {
    parent,
    attributes: { trigger, platform: Platform.OS },
  });
  try {
    const policy = createSamplingPolicy({ intervalMs: await loadShareIntervalMs(kv) });
    // Ambient cadence only. A self-heal never restores live mode: the watcher's window has almost
    // certainly lapsed by now, and resurrecting a 4-second cadence unattended is how this failure
    // mode compounds instead of ending.
    const decision = policy.decide({ battery: await createBatterySource().read() });
    span.setAttribute('decision.interval_ms', decision.timeIntervalMs);
    await startBackgroundLocation(
      cfgFromDecision(decision, {
        title: 'streetCryptid',
        body: "Keeping your friends' map current.",
        color: '#C6791A',
      })
    );
    span.setStatus('ok');
    return true;
  } catch (err) {
    // Android 12+ forbids starting a foreground service from the background, and
    // `startLocationUpdatesAsync` starts one. Distinguish it from a genuine failure: on a `backfill`
    // trigger this is the documented, expected outcome and the platform's own restore paths (boot
    // receiver, START_REDELIVER_INTENT) are what actually cover that case. On a `geofence` trigger
    // it is NOT expected — a geofence transition is on Android's exemption list — so seeing it there
    // means the exemption is not applying and is worth investigating. Never rethrow: a failed
    // self-heal must not fail its caller, which is usually a backfill with real work still to do.
    const message = err instanceof Error ? err.message : String(err);
    const blocked = /ForegroundServiceStartNotAllowed|not allowed to start service/i.test(message);
    span.setAttribute('sc.drop_reason', blocked ? 'fgs-start-blocked' : 'selfheal-failed');
    span.recordError(err);
    if (!blocked || trigger === 'geofence') {
      console.warn('[background-location] self-heal re-arm failed', err);
    }
    return false;
  } finally {
    span.end();
  }
}

/**
 * Publish queued fixes from a fresh headless context — the SEND path when the app is backgrounded or
 * killed. Called by the location TaskManager handler after it persists a batch. No-op while active
 * (the mounted runtime drains the outbox itself) or when nothing is queued.
 */
export function flushBackgroundOutboxHeadless(parent?: SpanContext): Promise<number> {
  return runHeadless({
    precheck: async () => (await backgroundOutbox.pending()) > 0,
    fallback: 0,
    run: async (service) => {
      const published = await backgroundOutbox.drain(async (fix, drainParent) => {
        await service.publishFix(fix, drainParent);
      }, parent);
      // `publishFix` only broadcasts live (to a swarm that is usually empty out here) and writes
      // the LOCAL docs replica. Without this push the envelopes never leave the phone, so a friend
      // who wasn't online at this exact moment never sees them — the whole reason the stash exists.
      // Must happen before the `finally` in `session()` shuts the node down.
      if (published > 0) await service.pushTrail(parent);
      return published;
    },
  });
}

/**
 * Periodic RECEIVE path: backfill fixes missed while backgrounded (from the trail-stash + peers),
 * then publish anything still queued. Driven by the `expo-background-task` scheduler — see
 * `backfill-task.ts`. No-op while the app is active (the foreground lifecycle already syncs).
 */
export function runBackgroundBackfillHeadless(parent?: SpanContext): Promise<void> {
  // If a mounted runtime is alive it owns the process-wide native node. On Android that runtime
  // stays alive while backgrounded (the location foreground service), so `AppState` is NOT 'active'
  // and the `session()` guard alone would let us spin up a SECOND node here — whose `createNode`
  // calls `clearRuntime()` and tears the live node's subscriptions down, silently killing outgoing
  // publishes and live receive until relaunch. Route the backfill to the live runtime instead.
  // Self-heal BEFORE anything else, and regardless of whether a runtime is mounted. On iOS this
  // periodic wake is a regular opportunity to notice that the location task died with a previous
  // process. On Android it is only a backstop — boot and process-kill are already covered by the
  // platform (see `ensureSharingArmedHeadless`) — and is expected to be refused when it does fire.
  void ensureSharingArmedHeadless('backfill', parent);

  const runMounted = getActiveBackfillHandler();
  if (runMounted) return runMounted(parent);
  return runHeadless<void>({
    fallback: undefined,
    run: async (service) => {
      // Drain FIRST, then sync. `syncTrail` is bidirectional, so the one call both pushes what we
      // just published and pulls what friends left at the stash. Syncing first (as this did) meant
      // every fix published here waited for the *next* OS wake to be pushed — ~15 min at best on
      // Android, and on iOS potentially never.
      if ((await backgroundOutbox.pending()) > 0) {
        await backgroundOutbox.drain(async (fix, drainParent) => {
          await service.publishFix(fix, drainParent);
        }, parent);
      }
      await service.syncTrail(0, parent);
    },
  });
}
