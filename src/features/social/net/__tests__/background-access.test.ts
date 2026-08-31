/**
 * How the app learns whether it actually has background location.
 *
 * The answer used to be latched from the single `requestBackgroundPermissionsAsync` round-trip that
 * `startBackground` made at start-up. On iOS that call resolves before Core Location's authorization
 * delegate has settled, so on 2026-08-30 a fresh install read "denied" at 17:44:13 and reported
 * `perm.ios_scope = always` two seconds later — and because nothing re-read it, the phone spent the
 * evening showing "allow background location" while holding full permission.
 *
 * These pin the two halves of the correction: the live native read wins, and a stale answer is
 * replaced rather than kept.
 */

const permissionHolder: { background: 'granted' | 'denied'; getCalls: number } = {
  background: 'denied',
  getCalls: 0,
};

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  requestBackgroundPermissionsAsync: async () => ({ status: permissionHolder.background }),
  getBackgroundPermissionsAsync: async () => {
    permissionHolder.getCalls += 1;
    return { status: permissionHolder.background };
  },
}));

/** Only the surface `refreshBackgroundAccess` touches; everything else stays undefined. */
class FakeNativeModule {
  /** `undefined` stands for a binary that predates the export — the guard AGENTS.md asks for. */
  authorized: boolean | undefined = undefined;
  /** Set to make the native read throw, so the fallback is exercised rather than assumed. */
  authorizedThrows = false;

  async createNode() {
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  async start() {}
  async shutdown() {}

  nativeBackgroundAuthorized?(): boolean;
}

const mockHolder: { mod: FakeNativeModule } = { mod: new FakeNativeModule() };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => null,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('SQLite is deliberately unavailable in this suite');
  },
}));

// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

const running: LocationSharingService[] = [];

function makeService(): LocationSharingService {
  const svc = new LocationSharingService();
  running.push(svc);
  return svc;
}

/** Attach the native export in the shape the runtime uses (an own method, optionally throwing). */
function withNativeAuthorization(value: boolean, throws = false): void {
  mockHolder.mod.nativeBackgroundAuthorized = () => {
    if (throws) throw new Error('binary is older than the JS bundle');
    return value;
  };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
  mockHolder.mod = new FakeNativeModule();
  permissionHolder.background = 'denied';
  permissionHolder.getCalls = 0;
});

describe('refreshBackgroundAccess', () => {
  it('reports full access from the native read even while expo-location still says denied', async () => {
    // The fresh-install race, exactly: `expo-location` has not caught up, but Core Location's own
    // `authorizationStatus` — the value background updates actually depend on — already has.
    permissionHolder.background = 'denied';
    withNativeAuthorization(true);

    await expect(makeService().refreshBackgroundAccess()).resolves.toBe('full');
  });

  it('falls back to expo-location on a binary that predates the native export', async () => {
    // A phone can be running an older binary than the JS bundle, so the export is guarded rather
    // than assumed. The fallback has to be a real answer, not `foreground` by default.
    permissionHolder.background = 'granted';
    expect(mockHolder.mod.nativeBackgroundAuthorized).toBeUndefined();

    await expect(makeService().refreshBackgroundAccess()).resolves.toBe('full');
    expect(permissionHolder.getCalls).toBe(1);
  });

  it('falls back when the native read throws rather than reporting foreground', async () => {
    permissionHolder.background = 'granted';
    withNativeAuthorization(false, true);

    await expect(makeService().refreshBackgroundAccess()).resolves.toBe('full');
    expect(permissionHolder.getCalls).toBe(1);
  });

  it('reports foreground when neither source grants it', async () => {
    permissionHolder.background = 'denied';
    withNativeAuthorization(false);

    await expect(makeService().refreshBackgroundAccess()).resolves.toBe('foreground');
  });

  it('publishes the change on the snapshot, which is what clears the banner', async () => {
    // The UI derives its status from `backgroundAccess`, so an answer that improves in silence is
    // the same bug as an answer that never improves.
    const svc = makeService();
    withNativeAuthorization(false);
    await svc.refreshBackgroundAccess();

    const seen: string[] = [];
    const off = svc.onChange((next) => seen.push(next.backgroundAccess));

    withNativeAuthorization(true);
    await svc.refreshBackgroundAccess();
    off();

    expect(seen).toContain('full');
  });

  it('stays quiet when the answer has not moved', async () => {
    // Emitted on every foreground, so an unconditional emit would re-render the whole tree each
    // time the user switched back to the app.
    const svc = makeService();
    withNativeAuthorization(true);
    await svc.refreshBackgroundAccess();

    let emits = 0;
    // `onChange` replays the current snapshot to a new listener, so the baseline is 1, not 0.
    const off = svc.onChange(() => (emits += 1));
    expect(emits).toBe(1);

    await svc.refreshBackgroundAccess();
    off();

    expect(emits).toBe(1);
  });
});
