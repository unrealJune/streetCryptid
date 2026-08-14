/**
 * FORWARD-SECRECY.md §7 step 0 — backup + keychain semantics.
 *
 * Asserts (1) every secure-store write pins the THIS_DEVICE_ONLY / AFTER_FIRST_UNLOCK
 * accessibility class, (2) static identity keys stay best-effort, (3) the sequential `seq`
 * counter is fail-stop: a persist failure propagates and aborts the publish before anything
 * reaches the wire.
 */

const mockSecureStore = {
  store: new Map<string, string>(),
  failKeys: new Set<string>(),
  setCalls: [] as { key: string; value: string; options: unknown }[],
};

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'mock-after-first-unlock-this-device-only',
  getItemAsync: async (key: string) => mockSecureStore.store.get(key) ?? null,
  setItemAsync: async (key: string, value: string, options: unknown) => {
    mockSecureStore.setCalls.push({ key, value, options });
    if (mockSecureStore.failKeys.has(key)) {
      throw new Error(`secure store write failed for ${key}`);
    }
    mockSecureStore.store.set(key, value);
  },
}));

// Fail the SQLite open so persistence.ts falls back to in-memory (see location-sharing.test.ts).
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('SQLite is deliberately unavailable in this suite');
  },
}));

class FakeNativeModule {
  calls = { publish: [] as unknown[][], docsWrite: [] as unknown[][] };
  async createNode() {
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  async start() {}
  async shutdown() {}
  async ticket() {
    return 'ticket-self';
  }
  async docTicket() {
    return 'doc-self';
  }
  async importDocTicket() {}
  async deriveTopic(id: string) {
    return `topic-${id}`;
  }
  async subscribe(topic: string) {
    return `sub-${topic}`;
  }
  async unsubscribe() {}
  async publish(...args: unknown[]) {
    this.calls.publish.push(args);
  }
  async docsWrite(...args: unknown[]) {
    this.calls.docsWrite.push(args);
  }
  async docsWriteControl() {}
  async syncTrail() {}
  async readTrail() {
    return [];
  }
  async pruneTrail() {}
  addListener() {
    return { remove: () => {} };
  }
}

const mockHolder: { mod: FakeNativeModule } = { mod: new FakeNativeModule() };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => null,
}));

// eslint-disable-next-line import/first
import { saveKeys, SECURE_STORE_OPTIONS } from '../secure-keys';
// eslint-disable-next-line import/first
import { loadSeq, saveSeq } from '../state-store';
// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

const SEQ_KEY = 'sc.social.seq.v2';

beforeEach(() => {
  mockSecureStore.store.clear();
  mockSecureStore.failKeys.clear();
  mockSecureStore.setCalls.length = 0;
});

describe('secure-store accessibility class (step 0)', () => {
  it('pins AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY in the shared options object', () => {
    expect(SECURE_STORE_OPTIONS).toEqual({
      keychainAccessible: 'mock-after-first-unlock-this-device-only',
    });
  });

  it('passes the options object on every setItemAsync call (keys and seq)', async () => {
    await saveKeys({ identitySecret: 'id-secret', recvSecret: 'recv-secret' });
    await saveSeq(7);
    expect(mockSecureStore.setCalls).toHaveLength(3);
    for (const call of mockSecureStore.setCalls) {
      expect(call.options).toBe(SECURE_STORE_OPTIONS);
    }
  });

  it('migrates legacy WHEN_UNLOCKED values to new background-readable keys', async () => {
    mockSecureStore.store.set('sc.iroh.identitySecret', 'legacy-id');
    mockSecureStore.store.set('sc.iroh.recvSecret', 'legacy-recv');
    mockSecureStore.store.set('sc.social.seq', '41');

    await expect(loadSeq()).resolves.toBe(41);
    expect(mockSecureStore.store.get('sc.social.seq.v2')).toBe('41');
  });
});

describe('persistence semantics (step 0)', () => {
  it('static identity keys stay best-effort: a failed write does not throw', async () => {
    mockSecureStore.failKeys.add('sc.iroh.identitySecret');
    await expect(
      saveKeys({ identitySecret: 'id-secret', recvSecret: 'recv-secret' })
    ).resolves.toBeUndefined();
  });

  it('sequential seq state is fail-stop: a failed write rejects', async () => {
    mockSecureStore.failKeys.add(SEQ_KEY);
    await expect(saveSeq(3)).rejects.toThrow('secure store write failed');
  });

  it('round-trips seq through the store', async () => {
    await saveSeq(41);
    await expect(loadSeq()).resolves.toBe(41);
  });

  it('aborts the publish (nothing on the wire) when seq persistence fails', async () => {
    mockHolder.mod = new FakeNativeModule();
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      mockSecureStore.failKeys.add(SEQ_KEY);
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).rejects.toThrow('secure store write failed');
      expect(mockHolder.mod.calls.publish).toHaveLength(0);
      expect(mockHolder.mod.calls.docsWrite).toHaveLength(0);

      // And once persistence works again, the next publish succeeds locally (no deadlock):
      // the failed attempt burned nothing that blocks recovery.
      mockSecureStore.failKeys.clear();
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 200 })
      ).resolves.toBeGreaterThan(0);
      expect(mockHolder.mod.calls.publish).toHaveLength(1);
    } finally {
      await svc.shutdownAsync();
    }
  });
});
