import type {
  BleCapabilities,
  BlePeer,
  BumpResolution,
  PairEvent,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
  SasChallenge,
} from 'iroh-location';

import type { ContactCard } from '../../core/types';

/**
 * Wiring tests for the bilateral-pairing / profile client state in {@link LocationSharingService},
 * using a fake native module. These prove the plumbing — local profile publish on init, invite
 * initiation WITHOUT auto-accept (SAS is mandatory), incoming requests staying pending, the SAS
 * `verifying` gate populating the snapshot, the dedicated picker/displayer/cancel actions calling
 * their native methods, a completed pair adding a friend with reciprocal sharing enabled, profile
 * events refreshing a friend, and polling cleanup on shutdown — without a live iroh node.
 */

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
    initiatePairNearby: [] as string[],
    respondPair: [] as { sessionId: string; accept: boolean }[],
    pairSasChallenge: [] as string[],
    submitPairChoice: [] as { sessionId: string; chosenIndex: number }[],
    confirmPairDisplay: [] as { sessionId: string; matched: boolean }[],
    cancelPair: [] as string[],
    setPairingReady: [] as boolean[],
    importProfileTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    unsubscribe: [] as string[],
    shutdown: 0,
    pollPairEvents: 0,
    pollProfileEvents: 0,
    listPairSessions: 0,
    pairResult: [] as string[],
    nearbyBlePeers: 0,
    bleCapabilities: 0,
    transportDiagnostics: 0,
    createNode: 0,
    start: 0,
  };

  // Drained-on-poll queues the test drives.
  pairEvents: PairEvent[] = [];
  profileEvents: ProfileView[] = [];
  sessions: PairStateRecord[] = [];
  peers: BlePeer[] = [];
  challenges = new Map<string, SasChallenge>();
  caps: BleCapabilities = {
    available: true,
    activeScanToggle: false,
    rssi: false,
    discoveryRefresh: false,
    pairingReady: false,
  };
  pairResults = new Map<string, PairResult>();
  profiles = new Map<string, ProfileView>();
  bumpResolution: BumpResolution = {
    status: 'noPeers',
    endpointId: null,
    deviceId: null,
    rssi: null,
    peerCount: 0,
    detail: 'none',
  };
  bumpResolutionPromise: Promise<BumpResolution> | null = null;
  initiateNearbyPromise: Promise<string> | null = null;
  initiateNearbyError: Error | null = null;
  initiateByTokenPromise: Promise<string> | null = null;
  bleAvailableAfterRestart = false;

  private handlers: Record<string, (e: unknown) => void> = {};

  async createNode() {
    this.calls.createNode += 1;
    if (this.calls.createNode > 1 && this.bleAvailableAfterRestart) {
      this.caps = { ...this.caps, available: true };
    }
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  async start() {
    this.calls.start += 1;
  }
  async shutdown() {
    this.calls.shutdown += 1;
  }
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
  async importProfileTicket(ticket: string) {
    this.calls.importProfileTicket.push(ticket);
  }
  async importDocTicket() {}
  async readProfile(endpointId: string) {
    return this.profiles.get(endpointId) ?? null;
  }
  async deriveTopic(id: string) {
    return `topic-${id}`;
  }
  async subscribe(topic: string, bootstrap: string[]) {
    this.calls.subscribe.push({ topic, bootstrap });
    return `sub-${topic}`;
  }
  async unsubscribe(subscriptionId: string) {
    this.calls.unsubscribe.push(subscriptionId);
  }
  async publish() {}
  async docsWrite() {}
  async syncTrail() {}
  async readTrail() {
    return [];
  }
  async pruneTrail() {}
  async transportDiagnostics() {
    this.calls.transportDiagnostics += 1;
    return { localAddresses: [], peers: [] };
  }

  async setPairingReady(ready: boolean) {
    this.calls.setPairingReady.push(ready);
    this.caps = { ...this.caps, pairingReady: ready };
  }
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
    return this.initiateByTokenPromise ?? 'sess-invite';
  }
  async initiatePairNearby(peer: string) {
    this.calls.initiatePairNearby.push(peer);
    if (this.initiateNearbyError) throw this.initiateNearbyError;
    return this.initiateNearbyPromise ?? 'sess-nearby';
  }
  async respondPair(sessionId: string, accept: boolean) {
    this.calls.respondPair.push({ sessionId, accept });
  }
  async pairSasChallenge(sessionId: string) {
    this.calls.pairSasChallenge.push(sessionId);
    return this.challenges.get(sessionId) ?? null;
  }
  async submitPairChoice(sessionId: string, chosenIndex: number) {
    this.calls.submitPairChoice.push({ sessionId, chosenIndex });
  }
  async confirmPairDisplay(sessionId: string, matched: boolean) {
    this.calls.confirmPairDisplay.push({ sessionId, matched });
  }
  async cancelPair(sessionId: string) {
    this.calls.cancelPair.push(sessionId);
    // Native cancel tears the session down: drop it and its challenge.
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
    this.challenges.delete(sessionId);
  }
  async pollPairEvents() {
    this.calls.pollPairEvents += 1;
    const drained = this.pairEvents;
    this.pairEvents = [];
    return drained;
  }
  async pollProfileEvents() {
    this.calls.pollProfileEvents += 1;
    const drained = this.profileEvents;
    this.profileEvents = [];
    return drained;
  }
  async listPairSessions() {
    this.calls.listPairSessions += 1;
    return this.sessions;
  }
  async pairResult(sessionId: string) {
    this.calls.pairResult.push(sessionId);
    return this.pairResults.get(sessionId) ?? null;
  }
  async nearbyBlePeers() {
    this.calls.nearbyBlePeers += 1;
    return this.peers;
  }
  async bleCapabilities() {
    this.calls.bleCapabilities += 1;
    return this.caps;
  }
  async bleAvailable() {
    return this.caps.available;
  }
  async resolveBumpPeer() {
    return this.bumpResolutionPromise ?? this.bumpResolution;
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
  getStashConfig: () => null,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

// eslint-disable-next-line import/first
import { LocationSharingService, type SharingSnapshot } from '../location-sharing';

function profileView(overrides: Partial<ProfileView> & { endpointId: string }): ProfileView {
  return {
    epoch: 100,
    handle: '@peer',
    cryptidName: 'Peer',
    sigil: 'sigil',
    color: '#123456',
    recvPub: 'peerrecv',
    ts: 100,
    ...overrides,
  };
}

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

function verifyingSession(
  overrides: Partial<PairStateRecord> & { sessionId: string }
): PairStateRecord {
  return {
    peerEndpointId: 'peerX',
    state: 'verifying',
    localAccepted: false,
    peerAccepted: false,
    initiator: true,
    nearby: false,
    sasVerified: true,
    localSasConfirmed: false,
    ...overrides,
  };
}

function sasChallenge(overrides: Partial<SasChallenge> = {}): SasChallenge {
  return {
    role: 'picker',
    targetIndex: 2,
    optionIndices: [1, 2, 3],
    deadlineMs: 9_999_999_999_999,
    ...overrides,
  };
}

const services: LocationSharingService[] = [];
function newService(): LocationSharingService {
  const svc = new LocationSharingService();
  services.push(svc);
  return svc;
}

/** Capture the latest emitted snapshot via a holder (avoids control-flow narrowing to `never`). */
function watch(svc: LocationSharingService): { current: SharingSnapshot | null } {
  const holder: { current: SharingSnapshot | null } = { current: null };
  svc.onChange((s) => {
    holder.current = s;
  });
  return holder;
}

describe('LocationSharingService — pairing / profile wiring', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
  });

  afterEach(() => {
    while (services.length) services.pop()?.shutdown();
  });

  it('ignores pairing-ready changes until node initialization is complete', async () => {
    const svc = newService();
    await svc.setPairingReady(true);
    expect(mockHolder.mod.calls.setPairingReady).toHaveLength(0);
  });

  it('publishes the local profile on init', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman', 'Mothra', '#111111');
    expect(mockHolder.mod.calls.publishProfile).toEqual([
      { handle: '@me', cryptidName: 'Mothra', sigil: 'mothman', color: '#111111' },
    ]);
  });

  it('publishes profile edits without rebuilding the node', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman', 'Mothra', '#111111');

    await svc.updateProfile('@new', 'owl', 'Night Owl', '#2F9E6A');

    expect(mockHolder.mod.calls.publishProfile).toEqual([
      { handle: '@me', cryptidName: 'Mothra', sigil: 'mothman', color: '#111111' },
      { handle: '@new', cryptidName: 'Night Owl', sigil: 'owl', color: '#2F9E6A' },
    ]);
    expect(snap.current?.self).toMatchObject({
      handle: '@new',
      sigil: 'owl',
      cryptidName: 'Night Owl',
      color: '#2F9E6A',
    });
  });

  it('restores a minimal publisher without interactive polling in headless mode', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.publishProfile).toHaveLength(0);
    expect(mockHolder.mod.calls.pollPairEvents).toBe(0);
    await expect(
      svc.publishFix({ lat: 47.62, lon: -122.32, accuracyM: 5, headingDeg: 0, ts: 1 })
    ).resolves.toBeGreaterThan(0);
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-aa11')).toBe(true);

    await svc.shutdownAsync();
    expect(mockHolder.mod.calls.unsubscribe).toContain('sub-topic-aa11');
    expect(mockHolder.mod.calls.shutdown).toBe(1);
  });

  it('creates an invite link and initiates without auto-accepting when pairing from it', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    const link = await svc.createPairInvite(300);
    expect(link).toMatch(/^streetcryptid:\/\/\/social\?token=/);

    await svc.pairFromInput(link);
    expect(mockHolder.mod.calls.initiatePairByToken).toEqual(['scpair1:cafef00d']);
    // SAS is mandatory: initiating must NOT auto-accept the local side.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
  });

  it('keeps an incoming pair request pending and rejects premature accept-via-respondPair', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairEvents = [
      { kind: 'pendingRequest', sessionId: 'incoming-1', peerEndpointId: 'peerX', nearby: false },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.pendingRequests.map((e) => e.sessionId)).toEqual(['incoming-1']);
    // Incoming requests are NOT auto-accepted.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);

    // Accepting now requires clearing the SAS gate — respondPair(accept=true) must fail explicitly
    // rather than bypass verification, and must never reach the native accept path.
    await expect(svc.respondPair('incoming-1', true)).rejects.toThrow(/no longer supported/i);
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
    expect(snap.current?.pairing.pendingRequests.map((e) => e.sessionId)).toEqual(['incoming-1']);

    // Rejecting still works and clears the pending request via the native reject path.
    await svc.respondPair('incoming-1', false);
    expect(mockHolder.mod.calls.respondPair).toEqual([{ sessionId: 'incoming-1', accept: false }]);
    expect(snap.current?.pairing.pendingRequests).toHaveLength(0);
  });

  it('moves a pending request into the SAS verification model when it reaches verifying', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairEvents = [
      { kind: 'pendingRequest', sessionId: 'incoming-2', peerEndpointId: 'peerY', nearby: false },
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.pendingRequests.map((e) => e.sessionId)).toEqual(['incoming-2']);

    // The handshake reaches the SAS gate. Even though listPairSessions is fetched in parallel with
    // the event queue (and may lag), a freshly emitted `verifying` event is reconciled into the
    // verification model and the stale pending request is dropped.
    mockHolder.mod.challenges.set(
      'incoming-2',
      sasChallenge({ role: 'displayer', targetIndex: 4, optionIndices: [4] })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'verifying', sessionId: 'incoming-2', peerEndpointId: 'peerY', nearby: false },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.pendingRequests).toHaveLength(0);
    expect(snap.current?.pairing.verifications).toEqual([
      {
        sessionId: 'incoming-2',
        peerEndpointId: 'peerY',
        nearby: false,
        role: 'displayer',
        targetIndex: 4,
        optionIndices: [4],
        deadlineMs: 9_999_999_999_999,
        localConfirmed: false,
        peerVerified: true,
      },
    ]);
  });

  it('recovers a verifying session from listPairSessions even when its event was missed', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // No `verifying` event this poll (e.g. missed while suspended) — only the session state shows
    // it. Reconciliation must still fetch the challenge and populate the snapshot.
    mockHolder.mod.sessions = [
      verifyingSession({
        sessionId: 'sess-recover',
        peerEndpointId: 'peerZ',
        nearby: true,
        localSasConfirmed: false,
      }),
    ];
    mockHolder.mod.challenges.set(
      'sess-recover',
      sasChallenge({ role: 'picker', targetIndex: 1, optionIndices: [0, 1, 2] })
    );
    await svc.refreshPairing();

    expect(snap.current?.pairing.verifications).toEqual([
      {
        sessionId: 'sess-recover',
        peerEndpointId: 'peerZ',
        nearby: true,
        role: 'picker',
        targetIndex: 1,
        optionIndices: [0, 1, 2],
        deadlineMs: 9_999_999_999_999,
        localConfirmed: false,
        peerVerified: true,
      },
    ]);
  });

  it('keeps the SAS panel through peer-first and local-first accepted phases', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({
        sessionId: 'sess-peer-first',
        peerEndpointId: 'peer-first',
        state: 'peerAccepted',
        peerAccepted: true,
      }),
      verifyingSession({
        sessionId: 'sess-local-first',
        peerEndpointId: 'local-first',
        state: 'localAccepted',
        localAccepted: true,
        localSasConfirmed: true,
      }),
    ];
    mockHolder.mod.challenges.set(
      'sess-peer-first',
      sasChallenge({ role: 'picker', targetIndex: 2, optionIndices: [1, 2, 3, 4] })
    );
    mockHolder.mod.challenges.set(
      'sess-local-first',
      sasChallenge({ role: 'displayer', targetIndex: 8, optionIndices: [8] })
    );
    await svc.refreshPairing();

    expect(snap.current?.pairing.verifications).toEqual([
      expect.objectContaining({
        sessionId: 'sess-peer-first',
        localConfirmed: false,
        peerVerified: true,
      }),
      expect.objectContaining({
        sessionId: 'sess-local-first',
        localConfirmed: true,
        peerVerified: true,
      }),
    ]);
  });

  it('clears a verification when its live challenge is gone (expired / decided)', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-gone', peerEndpointId: 'peerG' }),
    ];
    mockHolder.mod.challenges.set('sess-gone', sasChallenge());
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications.map((v) => v.sessionId)).toEqual(['sess-gone']);

    // The native challenge disappears (gate expired / decided). We must not fall back to a
    // challenge-less pairing — the entry is dropped.
    mockHolder.mod.challenges.delete('sess-gone');
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications).toHaveLength(0);
  });

  it('does not swallow a challenge-fetch error during reconciliation', async () => {
    const svc = newService();
    const errors: string[] = [];
    svc.onError((message) => {
      if (message) errors.push(message);
    });
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [verifyingSession({ sessionId: 'sess-err' })];
    mockHolder.mod.pairSasChallenge = async () => {
      throw new Error('challenge boom');
    };
    await svc.refreshPairing();

    expect(errors).toContain('challenge boom');
  });

  it('picker SAS action submits the choice via the dedicated native method', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-pick', peerEndpointId: 'peerP' }),
    ];
    mockHolder.mod.challenges.set(
      'sess-pick',
      sasChallenge({ role: 'picker', targetIndex: 2, optionIndices: [1, 2, 3] })
    );
    await svc.refreshPairing();

    await svc.submitPairChoice('sess-pick', 2);
    expect(mockHolder.mod.calls.submitPairChoice).toEqual([
      { sessionId: 'sess-pick', chosenIndex: 2 },
    ]);
    // Accepting never goes through the legacy respondPair(true) path.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
  });

  it('displayer SAS action confirms the display via the dedicated native method', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-show', peerEndpointId: 'peerD' }),
    ];
    mockHolder.mod.challenges.set('sess-show', sasChallenge({ role: 'displayer' }));
    await svc.refreshPairing();

    await svc.confirmPairDisplay('sess-show', true);
    expect(mockHolder.mod.calls.confirmPairDisplay).toEqual([
      { sessionId: 'sess-show', matched: true },
    ]);
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
  });

  it('rejects a role-mismatched SAS action without calling native', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-role', peerEndpointId: 'peerR' }),
    ];
    mockHolder.mod.challenges.set('sess-role', sasChallenge({ role: 'picker' }));
    await svc.refreshPairing();

    // A picker session must not accept a displayer confirmation.
    await expect(svc.confirmPairDisplay('sess-role', true)).rejects.toThrow(/awaiting a pick/i);
    expect(mockHolder.mod.calls.confirmPairDisplay).toHaveLength(0);
  });

  it('rejects an invalid picker index before crossing the native bridge', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');

    await expect(svc.submitPairChoice('sess-invalid', 256)).rejects.toThrow(RangeError);
    expect(mockHolder.mod.calls.submitPairChoice).toHaveLength(0);
  });

  it('cancel clears the verification, calls native cancel, and creates no friend', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-cancel', peerEndpointId: 'peer-cancel' }),
    ];
    mockHolder.mod.challenges.set('sess-cancel', sasChallenge());
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications.map((v) => v.sessionId)).toEqual(['sess-cancel']);

    await svc.cancelPair('sess-cancel');
    expect(mockHolder.mod.calls.cancelPair).toEqual(['sess-cancel']);
    expect(snap.current?.pairing.verifications).toHaveLength(0);
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-cancel')).toBe(false);
    expect(snap.current?.sharingWith).toEqual([]);
  });

  it('a failed pair after verification creates no friend or sharing grant', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-fail', peerEndpointId: 'peer-fail' }),
    ];
    mockHolder.mod.challenges.set('sess-fail', sasChallenge());
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications.map((v) => v.sessionId)).toEqual(['sess-fail']);

    // A wrong pick / mismatch fails the session natively. Even if a stale pairResult exists, a
    // `failed` event must never create a friend or grant.
    mockHolder.mod.pairResults.set(
      'sess-fail',
      pairResult({ sessionId: 'sess-fail', peerEndpointId: 'peer-fail' })
    );
    mockHolder.mod.sessions = [];
    mockHolder.mod.challenges.delete('sess-fail');
    mockHolder.mod.pairEvents = [
      { kind: 'failed', sessionId: 'sess-fail', peerEndpointId: 'peer-fail', nearby: false },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.verifications).toHaveLength(0);
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-fail')).toBe(false);
    expect(snap.current?.sharingWith).toEqual([]);
  });

  it('initiates the peer resolved by an explicit Bump without auto-accepting', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.bumpResolution = {
      status: 'resolved',
      endpointId: 'peer-nearby',
      deviceId: 'ble-one',
      rssi: -38,
      peerCount: 1,
      detail: 'resolved',
    };

    await svc.armBump();
    await svc.commitBump();

    expect(mockHolder.mod.calls.initiatePairNearby).toEqual(['peer-nearby']);
    // Bump starts discovery, but SAS is still mandatory — no side auto-accepts.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
  });

  it('fails closed when multiple Bump signals are equally close', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    mockHolder.mod.bumpResolution = {
      status: 'ambiguous',
      endpointId: null,
      deviceId: null,
      rssi: null,
      peerCount: 2,
      detail: 'ambiguous',
    };

    await svc.armBump();
    await svc.commitBump();

    expect(mockHolder.mod.calls.initiatePairNearby).toHaveLength(0);
    expect(snap.current?.pairing.bump.stage).toBe('failed');
    expect(snap.current?.pairing.bump.peerCount).toBe(2);
    expect(snap.current?.pairing.bump.error).toMatch(/more than one phone/i);
  });

  it('does not pair from a Bump result that arrives after cancellation', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    let resolveBump!: (result: BumpResolution) => void;
    mockHolder.mod.bumpResolutionPromise = new Promise((resolve) => {
      resolveBump = resolve;
    });

    await svc.armBump();
    const committing = svc.commitBump();
    await Promise.resolve();
    await svc.cancelBump();
    resolveBump({
      status: 'resolved',
      endpointId: 'too-late',
      deviceId: 'ble-late',
      rssi: -30,
      peerCount: 1,
      detail: 'late',
    });
    await committing;

    expect(mockHolder.mod.calls.initiatePairNearby).toHaveLength(0);
    expect(snap.current?.pairing.bump.stage).toBe('idle');
  });

  it('cancels a nearby session created after the user cancels during contact', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.bumpResolution = {
      status: 'resolved',
      endpointId: 'peer-slow',
      deviceId: 'ble-slow',
      rssi: -32,
      peerCount: 1,
      detail: 'resolved',
    };
    let resolveSession!: (sessionId: string) => void;
    mockHolder.mod.initiateNearbyPromise = new Promise((resolve) => {
      resolveSession = resolve;
    });

    await svc.armBump();
    const committing = svc.commitBump();
    await Promise.resolve();
    await Promise.resolve();
    await svc.cancelBump();
    resolveSession('sess-too-late');
    await committing;

    expect(mockHolder.mod.calls.cancelPair).toContain('sess-too-late');
  });

  it('does not cancel a simultaneous nearby session that reaches verification before initiation returns', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.bumpResolution = {
      status: 'resolved',
      endpointId: 'peer-simultaneous',
      deviceId: 'ble-simultaneous',
      rssi: -31,
      peerCount: 1,
      detail: 'resolved',
    };
    let resolveSession!: (sessionId: string) => void;
    mockHolder.mod.initiateNearbyPromise = new Promise((resolve) => {
      resolveSession = resolve;
    });

    await svc.armBump();
    const committing = svc.commitBump();
    await Promise.resolve();
    await Promise.resolve();
    mockHolder.mod.sessions = [
      verifyingSession({
        sessionId: 'sess-simultaneous',
        peerEndpointId: 'peer-simultaneous',
        nearby: true,
      }),
    ];
    mockHolder.mod.challenges.set('sess-simultaneous', sasChallenge());
    mockHolder.mod.pairEvents = [
      {
        kind: 'verifying',
        sessionId: 'sess-simultaneous',
        peerEndpointId: 'peer-simultaneous',
        nearby: true,
      },
    ];
    await svc.refreshPairing();
    resolveSession('sess-simultaneous');
    await committing;

    expect(mockHolder.mod.calls.cancelPair).not.toContain('sess-simultaneous');
  });

  it('lets an already-started handshake finish after the Bump discovery window expires', async () => {
    jest.useFakeTimers();
    try {
      const svc = newService();
      await svc.init('@me', 'mothman');
      mockHolder.mod.bumpResolution = {
        status: 'resolved',
        endpointId: 'peer-after-window',
        deviceId: 'ble-after-window',
        rssi: -33,
        peerCount: 1,
        detail: 'resolved',
      };
      let resolveSession!: (sessionId: string) => void;
      mockHolder.mod.initiateNearbyPromise = new Promise((resolve) => {
        resolveSession = resolve;
      });

      await svc.armBump(8000);
      const committing = svc.commitBump();
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(8100);
      resolveSession('sess-after-window');
      await committing;

      expect(mockHolder.mod.calls.cancelPair).not.toContain('sess-after-window');
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns Bump to a retryable failure when native initiation errors', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    mockHolder.mod.bumpResolution = {
      status: 'resolved',
      endpointId: 'peer-fail-start',
      deviceId: 'ble-fail-start',
      rssi: -35,
      peerCount: 1,
      detail: 'resolved',
    };
    mockHolder.mod.initiateNearbyError = new Error('dial rejected');

    await svc.armBump();
    await expect(svc.commitBump()).rejects.toThrow(/dial rejected/);

    expect(snap.current?.pairing.bump.stage).toBe('failed');
    expect(snap.current?.pairing.bump.error).toMatch(/handshake did not start/i);
  });

  it('tracks an inbound nearby request inside the Bump window without auto-accepting', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.armBump();
    mockHolder.mod.pairEvents = [
      {
        kind: 'pendingRequest',
        sessionId: 'nearby-incoming',
        peerEndpointId: 'peer-nearby',
        nearby: true,
      },
    ];

    await svc.refreshPairing();

    // The inbound nearby request is picked up (dropped from the pending list) but NOT accepted —
    // the handshake proceeds to the SAS gate, which the user then clears.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
    expect(snap.current?.pairing.pendingRequests).toHaveLength(0);
  });

  it('adds a paired friend and starts reciprocal location sharing on ready', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairResults.set(
      'sess-ready',
      pairResult({
        sessionId: 'sess-ready',
        peerEndpointId: 'peer-ready',
        peerProfile: profileView({ endpointId: 'peer-ready', epoch: 300, handle: '@fresh' }),
      })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-ready', peerEndpointId: 'peer-ready', nearby: false },
    ];
    await svc.refreshPairing();

    const friend = snap.current?.friends.find((f) => f.endpointId === 'peer-ready');
    expect(friend).toBeDefined();
    expect(friend?.handle).toBe('@fresh'); // verified profile applied
    expect(friend?.profileEpoch).toBe(300);
    expect(snap.current?.sharingWith).toEqual(['peer-ready']);
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-ready');
    // Subscribed + profile-imported via the normal friend path.
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-ready')).toBe(true);
    expect(
      mockHolder.mod.calls.subscribe.some(
        (s) => s.topic === 'topic-aa11' && s.bootstrap.includes('peer-ticket')
      )
    ).toBe(true);
    expect(mockHolder.mod.calls.importProfileTicket).toContain('peer-profile');

    await svc.armBump();
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-ready');
    expect(snap.current?.pairing.bump.stage).toBe('idle');

    svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.pairing.discoveredFriend).toBeNull();
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-ready')).toBe(true);
    expect(snap.current?.sharingWith).toEqual(['peer-ready']);
  });

  it('recovers a complete pair after its one-shot ready event arrives before the result', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [
      verifyingSession({
        sessionId: 'sess-recover',
        peerEndpointId: 'peer-recover',
        state: 'complete',
        localAccepted: true,
        peerAccepted: true,
        localSasConfirmed: true,
      }),
    ];
    mockHolder.mod.pairEvents = [
      {
        kind: 'ready',
        sessionId: 'sess-recover',
        peerEndpointId: 'peer-recover',
        nearby: false,
      },
    ];

    await svc.refreshPairing();
    expect(snap.current?.friends.some((friend) => friend.endpointId === 'peer-recover')).toBe(
      false
    );

    mockHolder.mod.pairResults.set(
      'sess-recover',
      pairResult({ sessionId: 'sess-recover', peerEndpointId: 'peer-recover' })
    );
    await svc.refreshPairing();
    expect(snap.current?.friends.some((friend) => friend.endpointId === 'peer-recover')).toBe(true);

    const callsAfterRecovery = mockHolder.mod.calls.pairResult.length;
    await svc.refreshPairing();
    expect(mockHolder.mod.calls.pairResult).toHaveLength(callsAfterRecovery);
  });

  it('creates the friend and grant on ready after the SAS verification clears', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // 1) Reach the SAS gate.
    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-v2r', peerEndpointId: 'peer-v2r' }),
    ];
    mockHolder.mod.challenges.set('sess-v2r', sasChallenge({ role: 'picker', targetIndex: 1 }));
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications.map((v) => v.sessionId)).toEqual(['sess-v2r']);
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-v2r')).toBe(false);

    // 2) Clear the SAS via the dedicated picker action (no friend yet — needs bilateral accept).
    await svc.submitPairChoice('sess-v2r', 1);
    expect(mockHolder.mod.calls.submitPairChoice).toEqual([
      { sessionId: 'sess-v2r', chosenIndex: 1 },
    ]);

    // 3) Only a native Ready creates the friend + reciprocal grant.
    mockHolder.mod.pairResults.set(
      'sess-v2r',
      pairResult({ sessionId: 'sess-v2r', peerEndpointId: 'peer-v2r' })
    );
    mockHolder.mod.sessions = [];
    mockHolder.mod.challenges.delete('sess-v2r');
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-v2r', peerEndpointId: 'peer-v2r', nearby: false },
    ];
    await svc.refreshPairing();

    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-v2r')).toBe(true);
    expect(snap.current?.sharingWith).toEqual(['peer-v2r']);
    expect(snap.current?.pairing.verifications).toHaveLength(0);
  });

  it('removes a discovered friend and revokes sharing when rejected', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairResults.set(
      'sess-rejected',
      pairResult({
        sessionId: 'sess-rejected',
        peerEndpointId: 'peer-rejected',
        peerProfile: profileView({ endpointId: 'peer-rejected', handle: '@nope' }),
      })
    );
    mockHolder.mod.pairEvents = [
      {
        kind: 'ready',
        sessionId: 'sess-rejected',
        peerEndpointId: 'peer-rejected',
        nearby: true,
      },
    ];
    await svc.refreshPairing();

    await svc.rejectDiscoveredFriend();

    expect(snap.current?.pairing.discoveredFriend).toBeNull();
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-rejected')).toBe(false);
    expect(snap.current?.sharingWith).toEqual([]);
    expect(mockHolder.mod.calls.unsubscribe).toContain('sub-topic-peer-rejected');
    expect(mockHolder.mod.calls.subscribe).toContainEqual({
      topic: 'topic-aa11',
      bootstrap: [],
    });
  });

  it('adds a placeholder friend when the pair has no verified profile yet', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairResults.set(
      'sess-np',
      pairResult({ sessionId: 'sess-np', peerEndpointId: 'aabbccddee', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-np', peerEndpointId: 'aabbccddee', nearby: false },
    ];
    await svc.refreshPairing();

    const friend = snap.current?.friends.find((f) => f.endpointId === 'aabbccddee');
    expect(friend).toBeDefined();
    expect(friend?.handle).toBe('@aabbccdd'); // safe placeholder from endpoint id
    expect(friend?.profileEpoch).toBeUndefined();
  });

  it('refreshes a known friend when a newer profile event arrives', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    const friend: ContactCard = {
      endpointId: 'bb22',
      handle: '@bee',
      sigil: 'jackalope',
      recvPublic: 'b0b0',
      ticket: 'ticket-b',
    };
    await svc.addFriend(friend);

    mockHolder.mod.profileEvents = [
      profileView({ endpointId: 'bb22', epoch: 500, handle: '@beeUpdated', sigil: 'newsig' }),
    ];
    await svc.refreshPairing();

    const updated = snap.current?.friends.find((f) => f.endpointId === 'bb22');
    expect(updated?.handle).toBe('@beeUpdated');
    expect(updated?.sigil).toBe('newsig');
    expect(updated?.profileEpoch).toBe(500);

    // An older profile event is ignored (monotonic).
    mockHolder.mod.profileEvents = [
      profileView({ endpointId: 'bb22', epoch: 400, handle: '@stale' }),
    ];
    await svc.refreshPairing();
    const still = snap.current?.friends.find((f) => f.endpointId === 'bb22');
    expect(still?.handle).toBe('@beeUpdated');
  });

  it('surfaces pairing readiness and capabilities into the snapshot', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    await svc.setPairingReady(true);
    await svc.refreshPairing();
    expect(snap.current?.pairing.ready).toBe(true);
    expect(mockHolder.mod.calls.setPairingReady).toEqual([true]);
    expect(snap.current?.pairing.capabilities?.available).toBe(true);
  });

  it('rebuilds a node that started before Bluetooth permission was granted', async () => {
    const svc = newService();
    mockHolder.mod.caps = { ...mockHolder.mod.caps, available: false };
    mockHolder.mod.bleAvailableAfterRestart = true;
    await svc.init('@me', 'mothman');

    await svc.ensureBleReady();

    expect(mockHolder.mod.calls.shutdown).toBe(1);
    expect(mockHolder.mod.calls.createNode).toBe(2);
    expect(mockHolder.mod.calls.start).toBe(2);
    expect(await mockHolder.mod.bleAvailable()).toBe(true);
  });

  it('does not rebuild BLE while another pairing session is active', async () => {
    const svc = newService();
    mockHolder.mod.caps = { ...mockHolder.mod.caps, available: false };
    mockHolder.mod.bleAvailableAfterRestart = true;
    await svc.init('@me', 'mothman');
    mockHolder.mod.sessions = [verifyingSession({ sessionId: 'active-session' })];
    await svc.refreshPairing();

    await expect(svc.ensureBleReady()).rejects.toThrow(/current pairing/i);
    expect(mockHolder.mod.calls.shutdown).toBe(0);
    expect(mockHolder.mod.calls.createNode).toBe(1);
  });

  it('does not rebind BLE while native pair initiation is in flight', async () => {
    const svc = newService();
    mockHolder.mod.caps = { ...mockHolder.mod.caps, available: false };
    mockHolder.mod.bleAvailableAfterRestart = true;
    await svc.init('@me', 'mothman');
    let resolveSession!: (sessionId: string) => void;
    mockHolder.mod.initiateByTokenPromise = new Promise((resolve) => {
      resolveSession = resolve;
    });

    const pairing = svc.pairFromInput('scpair1:slow');
    await Promise.resolve();
    await expect(svc.ensureBleReady()).rejects.toThrow(/pairing action/i);
    expect(mockHolder.mod.calls.shutdown).toBe(0);

    resolveSession('sess-slow');
    await pairing;
  });

  it('stops polling after shutdown', async () => {
    jest.useFakeTimers();
    try {
      const svc = new LocationSharingService();
      await svc.init('@me', 'mothman');
      await jest.advanceTimersByTimeAsync(0); // flush the immediate init poll

      const afterInit = mockHolder.mod.calls.pollPairEvents;
      await jest.advanceTimersByTimeAsync(5000);
      expect(mockHolder.mod.calls.pollPairEvents).toBeGreaterThan(afterInit);

      svc.shutdown();
      const afterShutdown = mockHolder.mod.calls.pollPairEvents;
      await jest.advanceTimersByTimeAsync(20000);
      expect(mockHolder.mod.calls.pollPairEvents).toBe(afterShutdown);
    } finally {
      jest.useRealTimers();
    }
  });
});
