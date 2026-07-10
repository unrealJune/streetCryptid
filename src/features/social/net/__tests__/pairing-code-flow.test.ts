import type {
  BleCapabilities,
  BlePeer,
  PairEvent,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
} from 'iroh-location';

/**
 * Wiring tests for the encrypted short pairing-code path (`createPairCode` / `pairFromInput`) in
 * {@link LocationSharingService}, using a fake native module and a fake in-memory
 * {@link PairingMailbox}. Jest can't run Expo's native AES module directly, so `expo-crypto` is
 * mocked here with a Node-`crypto`-backed fake that preserves real AES-256-GCM semantics (random
 * 12-byte IV, 16-byte tag, AAD-bound) — see the module mock below.
 */

// jest.mock factories can't close over outer module scope, so `crypto` is required lazily inside
// and the AES key/sealed-data classes are defined inline.
jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories can't close over outer scope, so `crypto` must be required lazily inside
  const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');

  class AESEncryptionKey {
    bytes: Uint8Array;
    constructor(bytes: Uint8Array) {
      this.bytes = bytes;
    }
    static async import(bytes: Uint8Array): Promise<AESEncryptionKey> {
      return new AESEncryptionKey(new Uint8Array(bytes));
    }
  }

  class AESSealedData {
    combinedBuf: Buffer;
    constructor(combinedBuf: Buffer) {
      this.combinedBuf = combinedBuf;
    }
    static fromCombined(combined: string): AESSealedData {
      return new AESSealedData(Buffer.from(combined, 'base64'));
    }
    async combined(encoding?: 'bytes' | 'base64'): Promise<string | Uint8Array> {
      return encoding === 'base64'
        ? this.combinedBuf.toString('base64')
        : new Uint8Array(this.combinedBuf);
    }
  }

  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    getRandomBytesAsync: async (n: number) => new Uint8Array(randomBytes(n)),
    digest: async (_alg: string, data: Uint8Array) => {
      const hash = createHash('sha256').update(Buffer.from(data)).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    },
    AESEncryptionKey,
    AESSealedData,
    aesEncryptAsync: async (
      plaintext: Uint8Array,
      key: InstanceType<typeof AESEncryptionKey>,
      options: { additionalData?: Uint8Array } = {}
    ) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(key.bytes), iv);
      if (options.additionalData) cipher.setAAD(Buffer.from(options.additionalData));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      const tag = cipher.getAuthTag();
      return new AESSealedData(Buffer.concat([iv, ciphertext, tag]));
    },
    aesDecryptAsync: async (
      sealed: InstanceType<typeof AESSealedData>,
      key: InstanceType<typeof AESEncryptionKey>,
      options: { additionalData?: Uint8Array } = {}
    ) => {
      const combined = sealed.combinedBuf;
      const iv = combined.subarray(0, 12);
      const tag = combined.subarray(combined.length - 16);
      const ciphertext = combined.subarray(12, combined.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.bytes), iv);
      if (options.additionalData) decipher.setAAD(Buffer.from(options.additionalData));
      decipher.setAuthTag(tag);
      return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
    },
  };
});

interface PublishProfileCall {
  handle: string;
  cryptidName: string;
  sigil: string;
  color: string;
}

class FakeNativeModule {
  calls = {
    publishProfile: [] as PublishProfileCall[],
    initiatePairByToken: [] as string[],
    respondPair: [] as { sessionId: string; accept: boolean }[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
  };

  pairEvents: PairEvent[] = [];
  profileEvents: ProfileView[] = [];
  sessions: PairStateRecord[] = [];
  peers: BlePeer[] = [];
  caps: BleCapabilities = {
    available: true,
    activeScanToggle: false,
    rssi: false,
    discoveryRefresh: false,
    pairingReady: false,
  };
  pairResults = new Map<string, PairResult>();

  private handlers: Record<string, (e: unknown) => void> = {};

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
  async publishProfile(handle: string, cryptidName: string, sigil: string, color: string) {
    this.calls.publishProfile.push({ handle, cryptidName, sigil, color });
    return 1000;
  }
  async profileTicket() {
    return 'profile-self';
  }
  async importProfileTicket() {}
  async importDocTicket() {}
  async readProfile() {
    return null;
  }
  async deriveTopic(id: string) {
    return `topic-${id}`;
  }
  async subscribe(topic: string, bootstrap: string[]) {
    this.calls.subscribe.push({ topic, bootstrap });
    return `sub-${topic}`;
  }
  async unsubscribe() {}
  async publish() {}
  async docsWrite() {}
  async syncTrail() {}
  async readTrail() {
    return [];
  }
  async pruneTrail() {}

  async setPairingReady() {}
  async createPairInvite(_ttlSecs: number): Promise<PairInviteWithToken> {
    return {
      version: 1,
      inviteId: 'iid',
      secret: 'sec',
      endpointId: 'aa11',
      endpointTicket: 'et',
      expiresAtMs: 0,
      token: 'scpair1:cafef00d',
    };
  }
  async initiatePairByToken(token: string) {
    this.calls.initiatePairByToken.push(token);
    return 'sess-invite';
  }
  async initiatePairNearby(peer: string) {
    return `sess-${peer}`;
  }
  async respondPair(sessionId: string, accept: boolean) {
    this.calls.respondPair.push({ sessionId, accept });
  }
  async pollPairEvents() {
    const drained = this.pairEvents;
    this.pairEvents = [];
    return drained;
  }
  async pollProfileEvents() {
    const drained = this.profileEvents;
    this.profileEvents = [];
    return drained;
  }
  async listPairSessions() {
    return this.sessions;
  }
  async pairResult(sessionId: string) {
    return this.pairResults.get(sessionId) ?? null;
  }
  async nearbyBlePeers() {
    return this.peers;
  }
  async bleCapabilities() {
    return this.caps;
  }

  addListener(name: string, cb: (e: unknown) => void) {
    this.handlers[name] = cb;
    return {
      remove: () => {
        delete this.handlers[name];
      },
    };
  }
}

const mockHolder: { mod: FakeNativeModule } = { mod: new FakeNativeModule() };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

/* eslint-disable import/first */
import { deriveLookupId, mintPairingCode, PairingCodeError } from '../../core/pairing-code';
import { PairingMailboxNotFoundError, type PairingMailbox } from '../pairing-mailbox';
import { LocationSharingService, type SharingSnapshot } from '../location-sharing';
/* eslint-enable import/first */

function pairResult(overrides: Partial<PairResult> & { sessionId: string }): PairResult {
  return {
    peerEndpointId: 'peer1',
    peerRecvPub: 'peerrecv',
    peerEndpointTicket: 'peer-ticket',
    peerProfileTicket: 'peer-profile',
    peerTrailTicket: 'peer-trail',
    peerProfile: null,
    ...overrides,
  };
}

/** In-memory fake mailbox: one-time GET, mirroring the real server's burn-on-read semantics. */
class FakeMailbox implements PairingMailbox {
  configured = true;
  private store = new Map<string, string>();
  calls = {
    put: [] as { lookupId: string; capsule: string; ttlSeconds: number }[],
    take: [] as string[],
    burn: [] as string[],
  };

  async put(lookupId: string, capsule: string, ttlSeconds: number): Promise<void> {
    this.calls.put.push({ lookupId, capsule, ttlSeconds });
    this.store.set(lookupId, capsule);
  }

  async take(lookupId: string): Promise<string> {
    this.calls.take.push(lookupId);
    const capsule = this.store.get(lookupId);
    if (capsule === undefined) {
      throw new PairingMailboxNotFoundError('pairing mailbox: code not found or expired');
    }
    this.store.delete(lookupId);
    return capsule;
  }

  async burn(lookupId: string): Promise<void> {
    this.calls.burn.push(lookupId);
    this.store.delete(lookupId);
  }
}

const services: LocationSharingService[] = [];
function newService(mailbox?: PairingMailbox): LocationSharingService {
  const svc = new LocationSharingService(mailbox ? { mailbox } : {});
  services.push(svc);
  return svc;
}

function watch(svc: LocationSharingService): { current: SharingSnapshot | null } {
  const holder: { current: SharingSnapshot | null } = { current: null };
  svc.onChange((s) => {
    holder.current = s;
  });
  return holder;
}

describe('LocationSharingService — encrypted short pairing-code path', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
  });

  afterEach(() => {
    while (services.length) services.pop()?.shutdown();
  });

  it('createPairCode uploads sealed ciphertext (never the plaintext token) and surfaces it in the snapshot', async () => {
    const mailbox = new FakeMailbox();
    const svc = newService(mailbox);
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    expect(snap.current?.pairing.mailboxAvailable).toBe(true);
    expect(snap.current?.pairing.inviteCode).toBeNull();

    const code = await svc.createPairCode(300);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(snap.current?.pairing.inviteCode).toBe(code);

    expect(mailbox.calls.put).toHaveLength(1);
    const { capsule, ttlSeconds } = mailbox.calls.put[0];
    expect(capsule.startsWith('scmail1:')).toBe(true);
    // The opaque native token must never appear in what's sent to the (blind) mailbox.
    expect(capsule).not.toContain('cafef00d');
    expect(ttlSeconds).toBe(300);
  });

  it('redeems a pair code end-to-end: one-time downloads + decrypts the capsule, initiates, and auto-accepts', async () => {
    const mailbox = new FakeMailbox();
    const svc = newService(mailbox);
    await svc.init('@me', 'mothman');

    const code = await svc.createPairCode(300);
    const sessionId = await svc.pairFromInput(code);

    expect(sessionId).toBe('sess-invite');
    expect(mockHolder.mod.calls.initiatePairByToken).toEqual(['scpair1:cafef00d']);
    expect(mockHolder.mod.calls.respondPair).toContainEqual({
      sessionId: 'sess-invite',
      accept: true,
    });
    // A one-time GET must have burned the entry.
    expect(mailbox.calls.take).toHaveLength(1);
    await expect(mailbox.take(mailbox.calls.take[0])).rejects.toThrow(PairingMailboxNotFoundError);
  });

  it('tags the eventual friend "code" when paired via a short pairing code', async () => {
    const mailbox = new FakeMailbox();
    const svc = newService(mailbox);
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    const code = await svc.createPairCode(300);
    await svc.pairFromInput(code);

    mockHolder.mod.pairResults.set(
      'sess-invite',
      pairResult({ sessionId: 'sess-invite', peerEndpointId: 'peer-code' })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-invite', peerEndpointId: 'peer-code', nearby: false },
    ];
    await svc.refreshPairing();

    const friend = snap.current?.friends.find((f) => f.endpointId === 'peer-code');
    expect(friend?.pairingMethod).toBe('code');
  });

  it('createPairCode throws when the mailbox is not configured', async () => {
    const mailbox = new FakeMailbox();
    mailbox.configured = false;
    const svc = newService(mailbox);
    await svc.init('@me', 'mothman');
    await expect(svc.createPairCode()).rejects.toThrow(/pairing mailbox is not configured/);
  });

  it('pairFromInput throws when the mailbox is not configured for a well-formed code', async () => {
    const mailbox = new FakeMailbox();
    mailbox.configured = false;
    const svc = newService(mailbox);
    await svc.init('@me', 'mothman');
    const minted = await mintPairingCode(async () => new Uint8Array(10).fill(3));
    await expect(svc.pairFromInput(minted.display)).rejects.toThrow(
      /pairing mailbox is not configured/
    );
  });

  it('surfaces a not-found mailbox error precisely, without falling back to any other pairing route', async () => {
    const mailbox = new FakeMailbox();
    const svc = newService(mailbox);
    await svc.init('@me', 'mothman');
    const minted = await mintPairingCode(async () => new Uint8Array(10).fill(9));
    await expect(svc.pairFromInput(minted.display)).rejects.toThrow(PairingMailboxNotFoundError);
    expect(mockHolder.mod.calls.initiatePairByToken).toHaveLength(0);
  });

  it('surfaces a capsule decryption failure precisely, without falling back', async () => {
    const mailbox = new FakeMailbox();
    const svc = newService(mailbox);
    await svc.init('@me', 'mothman');

    const minted = await mintPairingCode(async () => new Uint8Array(10).fill(5));
    const lookupId = await deriveLookupId(minted.secret);
    // Plant a capsule that will fail to decrypt/authenticate under the code's derived key.
    await mailbox.put(lookupId, `scmail1:${Buffer.alloc(40, 1).toString('base64')}`, 300);

    await expect(svc.pairFromInput(minted.display)).rejects.toThrow(PairingCodeError);
    expect(mockHolder.mod.calls.initiatePairByToken).toHaveLength(0);
  });

  it('defaults to an unconfigured mailbox when none is injected (new LocationSharingService() keeps working)', async () => {
    const originalEnv = process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL;
    delete process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL;
    try {
      const svc = newService();
      const snap = watch(svc);
      await svc.init('@me', 'mothman');
      expect(snap.current?.pairing.mailboxAvailable).toBe(false);
      await expect(svc.createPairCode()).rejects.toThrow(/pairing mailbox is not configured/);
    } finally {
      if (originalEnv !== undefined) process.env.EXPO_PUBLIC_PAIR_MAILBOX_URL = originalEnv;
    }
  });
});
