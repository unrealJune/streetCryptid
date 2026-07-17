import { AppState } from 'react-native';

import { flushBackgroundOutboxHeadless, runBackgroundBackfillHeadless } from '../headless-runtime';
import { registerActiveBackfillHandler } from '../register-task';

// The headless session news up a real LocationSharingService (→ native iroh `createNode`). Mock it so
// we can assert that the periodic backfill NEVER constructs one while a mounted runtime is alive —
// the regression where a second node's createNode → clearRuntime() tore the live node down.
// jest.mock factories may only reference `mock`-prefixed outer variables.
const mockInit = jest.fn(async () => {});
const mockSyncTrail = jest.fn(async () => {});
const mockShutdownAsync = jest.fn(async () => {});
const mockFlushDevTelemetry = jest.fn(async () => {});
const mockPublishFix = jest.fn(async () => 1);
const mockServiceCtor = jest.fn();

jest.mock('../../location-sharing', () => ({
  LocationSharingService: jest.fn().mockImplementation(() => {
    mockServiceCtor();
    return {
      init: mockInit,
      syncTrail: mockSyncTrail,
      publishFix: mockPublishFix,
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

function setAppState(state: string): void {
  (AppState as unknown as { currentState: string }).currentState = state;
}

describe('headless-runtime', () => {
  let unregister: (() => void) | null = null;
  const originalAppState = AppState.currentState;

  afterEach(() => {
    unregister?.();
    unregister = null;
    setAppState(originalAppState);
    jest.clearAllMocks();
  });

  describe('runBackgroundBackfillHeadless', () => {
    it('routes to the mounted runtime and never spins up a headless node when one is registered', async () => {
      // A backgrounded Android runtime is alive but NOT 'active' (the location foreground service).
      setAppState('background');
      const mountedBackfill = jest.fn(async () => {});
      unregister = registerActiveBackfillHandler(mountedBackfill);
      const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };

      await runBackgroundBackfillHeadless(parent);

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

      await runBackgroundBackfillHeadless(parent);

      expect(mockServiceCtor).toHaveBeenCalledTimes(1);
      expect(mockInit).toHaveBeenCalledTimes(1);
      expect(mockSyncTrail).toHaveBeenCalledWith(0, parent);
      expect(mockShutdownAsync).toHaveBeenCalledTimes(1);
    });

    it('does not run a headless session while the app is active', async () => {
      setAppState('active');

      await runBackgroundBackfillHeadless();

      expect(mockServiceCtor).not.toHaveBeenCalled();
    });
  });

  describe('flushBackgroundOutboxHeadless', () => {
    it('is a no-op while the app is active (the mounted runtime drains its own outbox)', async () => {
      setAppState('active');

      const published = await flushBackgroundOutboxHeadless();

      expect(published).toBe(0);
      expect(mockServiceCtor).not.toHaveBeenCalled();
    });
  });
});
