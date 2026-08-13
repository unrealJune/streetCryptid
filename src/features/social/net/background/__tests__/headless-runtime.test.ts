import { AppState } from 'react-native';

import {
  claimNativeRuntime,
  releaseNativeRuntime,
  resetNativeRuntimeOwnerForTesting,
} from '../native-runtime-owner';

import {
  ensureSharingArmedHeadless,
  flushBackgroundOutboxHeadless,
  runBackgroundRefreshHeadless,
} from '../headless-runtime';
import { registerActiveRefreshHandler } from '../register-task';

// The headless session news up a real LocationSharingService (→ native iroh `createNode`). Mock it so
// we can assert that the periodic backfill NEVER constructs one while a mounted runtime is alive —
// the regression where a second node's createNode → clearRuntime() tore the live node down.
// jest.mock factories may only reference `mock`-prefixed outer variables.
const mockInit = jest.fn(async () => {});
const mockSyncTrail = jest.fn(async () => {});
const mockShutdownAsync = jest.fn(async () => {});
const mockFlushDevTelemetry = jest.fn(async () => {});
const mockPublishFix = jest.fn(async () => 1);
const mockPushTrail = jest.fn(async () => {});
const mockServiceCtor = jest.fn();
/** Call order across the service, so we can assert drain-before-sync/push. */
const calls: string[] = [];

jest.mock('../../location-sharing', () => ({
  LocationSharingService: jest.fn().mockImplementation(() => {
    mockServiceCtor();
    return {
      init: mockInit,
      syncTrail: mockSyncTrail,
      publishFix: mockPublishFix,
      pushTrail: mockPushTrail,
      flushDevTelemetry: mockFlushDevTelemetry,
      shutdownAsync: mockShutdownAsync,
    };
  }),
}));

jest.mock('@/features/account/storage/profile-store', () => ({
  createCryptidProfileStore: jest.fn(() => ({
    load: jest.fn(async () => ({ handle: 'h', sigil: 's', cryptidName: 'c', color: '#fff' })),
  })),
}));

jest.mock('../background-outbox', () => ({
  backgroundOutbox: {
    pending: jest.fn(async () => 0),
    drain: jest.fn(async () => 0),
  },
}));

// The self-heal touches only the OS location task — no iroh node — so it is mocked at that seam.
const mockIsRunning = jest.fn(async () => false);
const mockStartBackgroundLocation = jest.fn(async (_cfg: unknown) => {});
// Spread the real module: `register-task` is pulled in transitively and needs the rest of it
// (`isBackgroundLocationAvailable`, `defineBackgroundLocationTask`) at import time.
jest.mock('../background-task', () => ({
  ...jest.requireActual('../background-task'),
  isBackgroundLocationRunning: () => mockIsRunning(),
  startBackgroundLocation: (cfg: unknown) => mockStartBackgroundLocation(cfg),
}));

const mockLoadSharingEnabled = jest.fn(async () => true);
jest.mock('../../persistence', () => ({
  createPersistentKV: jest.fn(() => ({})),
  loadSharingEnabled: () => mockLoadSharingEnabled(),
  loadShareIntervalMs: jest.fn(async () => 300_000),
}));

jest.mock('../battery-source', () => ({
  createBatterySource: jest.fn(() => ({
    read: jest.fn(async () => ({ level: 1, charging: false, lowPower: false })),
  })),
}));

function setAppState(state: string): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- mocked module, needs the handle
const { backgroundOutbox } = require('../background-outbox') as {
  backgroundOutbox: { pending: jest.Mock; drain: jest.Mock };
};

/** Arm the mocked outbox with `count` queued fixes that drain successfully. */
function queueFixes(count: number): void {
  let remaining = count;
  backgroundOutbox.pending.mockImplementation(async () => remaining);
  backgroundOutbox.drain.mockImplementation(async (publish: (fix: unknown) => Promise<void>) => {
    calls.push('drain');
    const n = remaining;
    for (let i = 0; i < n; i += 1)
      await publish({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: i });
    remaining = 0;
    return n;
  });
}

describe('headless-runtime', () => {
  let unregister: (() => void) | null = null;
  const originalAppState = AppState.currentState;

  beforeEach(() => {
    resetNativeRuntimeOwnerForTesting();
    calls.length = 0;
    mockSyncTrail.mockImplementation(async () => {
      calls.push('syncTrail');
    });
    mockPushTrail.mockImplementation(async () => {
      calls.push('pushTrail');
    });
    backgroundOutbox.pending.mockImplementation(async () => 0);
    backgroundOutbox.drain.mockImplementation(async () => 0);
  });

  afterEach(() => {
    unregister?.();
    unregister = null;
    setAppState(originalAppState);
    jest.clearAllMocks();
  });

  describe('runBackgroundRefreshHeadless', () => {
    it('routes to the mounted runtime and never spins up a headless node when one is registered', async () => {
      // A backgrounded Android runtime is alive but NOT 'active' (the location foreground service).
      setAppState('background');
      const mountedBackfill = jest.fn(async () => {});
      unregister = registerActiveRefreshHandler(mountedBackfill);
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      await runBackgroundRefreshHeadless(parent);

      expect(mountedBackfill).toHaveBeenCalledTimes(1);
      expect(mountedBackfill).toHaveBeenCalledWith(parent);
      // The critical guarantee: no second native node was created (which would clearRuntime() the
      // live one), so send + live receive keep working.
      expect(mockServiceCtor).not.toHaveBeenCalled();
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('falls back to a headless session when no mounted runtime is registered', async () => {
      setAppState('background');
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      await runBackgroundRefreshHeadless(parent);

      expect(mockServiceCtor).toHaveBeenCalledTimes(1);
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockSyncTrail).toHaveBeenCalledWith(0, parent);
      expect(mockShutdownAsync).toHaveBeenCalledTimes(1);
    });

    it('does not run a headless session while the app is active', async () => {
      setAppState('active');

      await runBackgroundRefreshHeadless();

      expect(mockServiceCtor).not.toHaveBeenCalled();
    });

    // syncTrail is bidirectional AND the only thing that pushes our own namespace to the stash.
    // Syncing before the drain stranded everything this wake published until the next OS wake.
    it('drains the outbox BEFORE syncing so freshly published fixes are pushed in the same wake', async () => {
      setAppState('background');
      queueFixes(2);

      await runBackgroundRefreshHeadless();

      expect(calls).toEqual(['drain', 'syncTrail']);
    });
  });

  describe('flushBackgroundOutboxHeadless', () => {
    it('is a no-op while the app is active (the mounted runtime drains its own outbox)', async () => {
      setAppState('active');

      const published = await flushBackgroundOutboxHeadless();

      expect(published).toBe(0);
      expect(mockServiceCtor).not.toHaveBeenCalled();
    });

    // publishFix broadcasts live and writes the LOCAL docs replica only. Without the push the
    // envelopes never leave the phone, so an offline friend has nothing to reconcile from.
    // The regression test for the silent-death bug. iOS reports 'inactive' — NOT 'active' — during a
    // cold launch into the foreground and for as long as a system permission alert is up ("Allow
    // While Using / Always"). The old guard only refused on 'active', so a restored location task
    // firing in either window spun up a second service whose `createNode` (and whose `shutdown` in
    // the session `finally`) calls `clearRuntime()`, nil'ing the node the mounted runtime was
    // building. Every later native call then throws `NoNode` into a `.catch` and the app renders
    // but does nothing, through relaunches, until reinstall.
    it('is a no-op while the app is merely inactive (cold launch / permission alert)', async () => {
      // Queued work, so the precheck passes and the guard is the ONLY thing that can refuse.
      backgroundOutbox.pending.mockImplementation(async () => 3);
      setAppState('inactive');

      const published = await flushBackgroundOutboxHeadless();

      expect(published).toBe(0);
      expect(mockServiceCtor).not.toHaveBeenCalled();
    });

    it('is a no-op while a mounted runtime holds the native-runtime claim', async () => {
      // Backgrounded, so the AppState guard alone would wave this through — but the mounted runtime
      // is alive and owns the node (iOS keeps it alive when the user backgrounds the app).
      backgroundOutbox.pending.mockImplementation(async () => 3);
      setAppState('background');
      claimNativeRuntime();
      try {
        const published = await flushBackgroundOutboxHeadless();

        expect(published).toBe(0);
        expect(mockServiceCtor).not.toHaveBeenCalled();
      } finally {
        releaseNativeRuntime();
      }
    });

    // Guards the other half: with the app genuinely backgrounded and no claim standing, the session
    // MUST still run, or the whole background pipeline silently stops delivering.
    it('still runs a session when the app is backgrounded and nothing holds the claim', async () => {
      backgroundOutbox.pending.mockImplementation(async () => 3);
      setAppState('background');

      await flushBackgroundOutboxHeadless();

      expect(mockServiceCtor).toHaveBeenCalledTimes(1);
    });

    it('pushes the durable trail to the stash after draining, before the node shuts down', async () => {
      setAppState('background');
      queueFixes(3);
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      const published = await flushBackgroundOutboxHeadless(parent);

      expect(published).toBe(3);
      expect(mockPublishFix).toHaveBeenCalledTimes(3);
      expect(mockPushTrail).toHaveBeenCalledWith(parent);
      expect(calls).toEqual(['drain', 'pushTrail']);
      // The node must still be alive for the push — shutdown is the session's `finally`.
      expect(mockPushTrail.mock.invocationCallOrder[0]).toBeLessThan(
        mockShutdownAsync.mock.invocationCallOrder[0]
      );
    });

    it('skips the push when nothing was published', async () => {
      setAppState('background');
      queueFixes(0);

      await flushBackgroundOutboxHeadless();

      expect(mockPushTrail).not.toHaveBeenCalled();
    });
  });

  // The self-heal is what turns a woken-but-dark phone back on. Its failure mode is silent by
  // nature — nothing publishes and nothing throws — so the guards are worth pinning down.
  describe('ensureSharingArmedHeadless', () => {
    beforeEach(() => {
      mockLoadSharingEnabled.mockImplementation(async () => true);
      mockIsRunning.mockImplementation(async () => false);
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {});
    });

    it('re-arms when sharing is enabled but the OS task is not running', async () => {
      await expect(ensureSharingArmedHeadless('geofence')).resolves.toBe(true);
      expect(mockStartBackgroundLocation).toHaveBeenCalledTimes(1);
      // Ambient cadence, never live: resurrecting a 4s cadence unattended is how the original
      // failure compounds instead of ending.
      expect(mockStartBackgroundLocation.mock.calls[0][0]).toMatchObject({
        timeIntervalMs: 300_000,
        distanceIntervalM: 0,
      });
    });

    it('does nothing when the user has sharing switched off', async () => {
      mockLoadSharingEnabled.mockImplementation(async () => false);

      await expect(ensureSharingArmedHeadless('refresh')).resolves.toBe(false);
      expect(mockStartBackgroundLocation).not.toHaveBeenCalled();
    });

    it('does nothing when the platform already restored the task itself', async () => {
      // Android's BOOT_COMPLETED receiver and START_REDELIVER_INTENT both land here.
      mockIsRunning.mockImplementation(async () => true);

      await expect(ensureSharingArmedHeadless('refresh')).resolves.toBe(false);
      expect(mockStartBackgroundLocation).not.toHaveBeenCalled();
    });

    it('swallows the Android background-FGS refusal instead of failing its caller', async () => {
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {
        throw new Error('ForegroundServiceStartNotAllowedException: startForegroundService()');
      });

      // Expected on a backfill wake, and must not reject — the caller still has real work to do.
      await expect(ensureSharingArmedHeadless('refresh')).resolves.toBe(false);
    });

    it('swallows an unexpected failure too', async () => {
      mockStartBackgroundLocation.mockImplementation(async (_cfg: unknown) => {
        throw new Error('location provider unavailable');
      });

      await expect(ensureSharingArmedHeadless('geofence')).resolves.toBe(false);
    });
  });
});
