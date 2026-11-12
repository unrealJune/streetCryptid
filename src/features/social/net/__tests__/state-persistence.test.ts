/**
 * FORWARD-SECRECY.md §7 step 0 — backup + keychain semantics.
 *
 * Asserts (1) every secure-store write pins the THIS_DEVICE_ONLY / AFTER_FIRST_UNLOCK
 * accessibility class, (2) static identity keys stay best-effort, (3) the keychain `seq`
 * reservation is fail-stop at the store and keeps native's counter above everything this identity
 * ever published, (4) native's own counter failing aborts the publish.
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

const ACCEPTED = {
  accepted: true,
  rejection: null,
  enqueued: 1,
  published: 1,
  pending: 0,
  slotsSkipped: 0,
  overflowDropped: 0,
  suspended: false,
};

/**
 * The docs-only native surface the service drives. It has no `seq` counter: it stands in for a
 * binary predating `seq_store.rs`, which the `typeof` guards still have to survive.
 */
class FakeNativeModule {
  calls = { ingestFix: 0, publishIntroduction: 0 };
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
  async ingestFix() {
    this.calls.ingestFix += 1;
    return ACCEPTED;
  }
  async heartbeatFix() {
    return { ...ACCEPTED, published: 0 };
  }
  async publishIntroduction() {
    this.calls.publishIntroduction += 1;
    return ACCEPTED;
  }
  async syncTrail() {}
  async readTrail() {
    return [];
  }
  async pruneTrail() {}
  addListener() {
    return { remove: () => {} };
  }
}

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
  /** The native drain issues the next `seq` from its own counter, durable before it returns. */
  override async ingestFix() {
    if (this.failNext) throw new Error('native counter write failed');
    this.counter += 1;
    return super.ingestFix();
  }
  async currentSeq() {
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
import { loadSeq, saveSeq, SEQ_RESERVATION_BLOCK, SEQ_RESERVATION_LOW_WATER } from '../state-store';
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
});

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

/**
 * `seq` is issued by the native node alone (`seq_store.rs`): every headless JS callback gets a
 * fresh context, so when JS issued it each held its own copy and each handed out `n + 1`. What JS
 * still owns is the keychain RESERVATION — the one store that survives an iOS reinstall — and
 * these assert it does that job: native never counts from below what this identity published, and
 * the reservation stays ahead of a counter that keeps moving.
 */
describe('native seq counter', () => {
  const fix = { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('seeds native with the persisted floor before anything can publish', async () => {
    await saveSeq(8_706);
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(mod.seeds).toEqual([8_706]);
      // Starting from 1 here would re-issue every key up to 8706 — the exact failure this guards.
      await expect(svc.forceLocationPush(fix)).resolves.toBe(8_707);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('keeps SecureStore AHEAD of the native counter, not level with it', async () => {
    // A REINSTALL meets a native counter of 0 with only the keychain left — on iOS the keychain
    // survives app deletion and `state_dir` does not. A mirror cannot serve that: it can only ever
    // lag, and the native drain path issues `seq` on background wakes with no JS alive to update
    // it. On 2026-09-12 that lag was 75 values, every one re-issued.
    const mod = new NativeSeqModule();
    mod.counter = 500;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await svc.forceLocationPush(fix);
      const reserved = await loadSeq();
      expect(reserved).toBe(500 + SEQ_RESERVATION_BLOCK);
      expect(reserved).toBeGreaterThan(mod.counter);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('claims a new block once native has issued into the low-water margin', async () => {
    // Background wakes issue values with no JS alive, so the foreground is the only place the
    // reservation can grow. A publish that lands inside the margin must top it up, or a phone
    // that is rarely opened walks off the end of its block.
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(await loadSeq()).toBe(SEQ_RESERVATION_BLOCK);
      mod.counter = SEQ_RESERVATION_BLOCK - SEQ_RESERVATION_LOW_WATER;

      await svc.forceLocationPush(fix);
      await settle();

      expect(await loadSeq()).toBe(mod.counter + SEQ_RESERVATION_BLOCK);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('does not touch the keychain on a publish well inside the reservation', async () => {
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      const writes = mockSecureStore.setCalls.filter((c) => c.key === SEQ_KEY).length;

      await svc.forceLocationPush(fix);
      await settle();

      expect(mockSecureStore.setCalls.filter((c) => c.key === SEQ_KEY)).toHaveLength(writes);
    } finally {
      await svc.shutdownAsync();
    }
  });

  /** The rewind itself: the reinstall case, where the keychain is all that is left. */
  it('recovers above everything published when the native counter is wiped', async () => {
    const first = new NativeSeqModule();
    first.counter = 6_776;
    mockHolder.mod = first;
    const before = new LocationSharingService();
    await before.init('@me', 'mothman');
    // The background drain path issues values with no JS context alive to see them.
    first.counter = 6_851;
    await before.shutdownAsync();

    // Reinstall: `state_dir` is gone, so the native counter is 0. The keychain is not.
    const after = new NativeSeqModule();
    mockHolder.mod = after;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await expect(svc.forceLocationPush(fix)).resolves.toBeGreaterThan(6_851);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('seeds again before the next publish when the seed at start failed', async () => {
    // Nothing in JS issues `seq` any more, so there is no fallback counter to retreat to. What JS
    // can still do is hand native the floor before asking it to publish anything.
    await saveSeq(300);
    const mod = new NativeSeqModule();
    mod.failSeed = true;
    mockHolder.mod = mod;
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      expect(mod.counter).toBe(0);
      mod.failSeed = false;

      await expect(svc.forceLocationPush(fix)).resolves.toBe(301);
      expect(mod.seeds).toEqual([300, 300]);

      // And only until it lands: a seed is a native write, not a per-publish toll.
      await svc.forceLocationPush(fix);
      expect(mod.seeds).toEqual([300, 300]);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('does not let a failed reservation write stop the publish', async () => {
    const mod = new NativeSeqModule();
    mockHolder.mod = mod;
    mockSecureStore.failKeys.add(SEQ_KEY);
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      await expect(svc.forceLocationPush(fix)).resolves.toBe(1);
      expect(mod.calls.ingestFix).toBe(1);
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
      await expect(svc.forceLocationPush(fix)).rejects.toThrow('native counter write failed');
      // Nothing goes out off the grid in its place.
      expect(mod.calls.publishIntroduction).toBe(0);
    } finally {
      await svc.shutdownAsync();
    }
  });

  it('still publishes on a binary with no counter exports', async () => {
    mockHolder.mod = new FakeNativeModule();
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    try {
      // Nothing to report the seq from, but the fix still went through the native gate.
      await expect(svc.forceLocationPush(fix)).resolves.toBe(0);
      expect(mockHolder.mod.calls.ingestFix).toBe(1);
    } finally {
      await svc.shutdownAsync();
    }
  });
});
