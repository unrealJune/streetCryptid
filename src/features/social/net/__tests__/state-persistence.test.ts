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

/**
 * A binary that has the native counter. `FakeNativeModule` deliberately does NOT — it stands in
 * for an installed build predating the API, which is the fallback path the `typeof` guards exist
 * for, and which the rest of this file exercises.
 */
/** A binary with the native device-identity store the background drain path reads. */
class NativeSecretsModule extends FakeNativeModule {
  saved: { identity: string; recv: string }[] = [];
  provisioned = false;
  failSave = false;
  async saveDeviceSecrets(identityHex: string, recvHex: string) {
    if (this.failSave) throw new Error('keystore refused the write');
    this.saved.push({ identity: identityHex, recv: recvHex });
    this.provisioned = true;
  }
  deviceSecretsProvisioned() {
    return this.provisioned;
  }
}

class NativeSeqModule extends FakeNativeModule {
  counter = 0;
  seeds: number[] = [];
  failSeed = false;
  failNext = false;
  async seedSeq(floor: number) {
    this.seeds.push(floor);
    if (this.failSeed) throw new Error('native seed failed');
    if (floor <= this.counter) return false;
    this.counter = floor;
    return true;
  }
  async nextSeq() {
    if (this.failNext) throw new Error('native counter write failed');
    this.counter += 1;
    return this.counter;
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

/**
 * The counter moved into the native node (`seq_store.rs`) because every headless JS callback gets
 * a fresh context, so each held its own copy of it and each handed out `n + 1`. These assert the
 * two things that migration must not break: the native counter never starts below what SecureStore
 * already published, and a binary without the API keeps working.
 */
/**
 * The identity has to reach a store the background path can read, because that path builds a node
 * with no JS context alive. `expo-secure-store` cannot serve it, so this is a mirror — safe here
 * only because the identity is immutable, unlike `seq`, which had to move rather than be copied.
 */
describe('native device-secret mirror', () => {
  it('writes the identity this session is actually using', async () => {
    const mod = new NativeSecretsModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(mod.saved).toEqual([{ identity: 'ii', recv: 'rr' }]);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('writes every launch, even when the store already looks provisioned', async () => {
    // The dangerous shortcut: an entry can survive an app uninstall on iOS, so "already
    // provisioned" can mean "holds an identity this install has never used". A background node
    // built on that would publish under an endpoint no friend has paired with — invisible from the
    // app, and absent from every trail.
    const mod = new NativeSecretsModule();
    mod.provisioned = true;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(mod.saved).toHaveLength(1);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('still starts when the keystore refuses the write', async () => {
    // The mounted path reads expo-secure-store and is untouched; what is lost is background
    // publishing. Failing init here would trade a degraded feature for a dead app.
    const mod = new NativeSecretsModule();
    mod.failSave = true;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await expect(svc.init('@me', 'mothman')).resolves.not.toThrow();
    await svc.shutdownAsync();
  });

  it('is skipped entirely on a binary built before the native store existed', async () => {
    mockHolder.mod = new FakeNativeModule();
    const svc = new LocationSharingService();
    await expect(svc.init('@me', 'mothman')).resolves.not.toThrow();
    await svc.shutdownAsync();
  });
});

describe('native seq counter', () => {
  it('seeds native with the persisted floor before anything can publish', async () => {
    await saveSeq(8_706);
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(mod.seeds).toEqual([8_706]);
      // Starting from 1 here would re-issue every key up to 8706 — the exact failure this guards.
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).resolves.toBe(8_707);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('mirrors each native value back to SecureStore as downgrade insurance', async () => {
    // An OTA that rolls the JS bundle back onto this binary resumes using state-store.ts; a
    // mirror left behind at the pre-migration value would re-issue everything published since.
    const mod = new NativeSeqModule();
    mod.counter = 500;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 });
      await expect(loadSeq()).resolves.toBe(501);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('keeps publishing when the SecureStore mirror fails — native already persisted', async () => {
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      mockSecureStore.failKeys.add(SEQ_KEY);
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).resolves.toBe(1);
      expect(mod.calls.publish).toHaveLength(1);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('stays fail-stop: a native counter that cannot persist aborts the publish', async () => {
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      mod.failNext = true;
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).rejects.toThrow('native counter write failed');
      expect(mod.calls.publish).toHaveLength(0);
      expect(mod.calls.docsWrite).toHaveLength(0);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('falls back to SecureStore rather than drawing from an unseeded native counter', async () => {
    // If the seed did not land, native does not know the floor. Using it anyway would restart
    // below values already on the wire, so the old path — monotonic on its own — is the safe one.
    await saveSeq(300);
    const mod = new NativeSeqModule();
    mod.failSeed = true;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).resolves.toBe(301);
      expect(mod.counter).toBe(0);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('uses SecureStore on a binary built before the native counter existed', async () => {
    await saveSeq(12);
    mockHolder.mod = new FakeNativeModule();
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await expect(
        svc.publishFix({ lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 })
      ).resolves.toBe(13);
    } finally {
      await svc.shutdownAsync();
    }
  });
});
