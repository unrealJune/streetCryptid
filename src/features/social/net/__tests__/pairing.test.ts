import type {
  BleCapabilities,
  BlePeer,
  PairEvent,
  PairInviteWithToken,
  PairResult,
  PairStateRecord,
  ProfileView,
} from 'iroh-location';

import type { ContactCard } from '../../core/types';

/**
 * Wiring tests for the bilateral-pairing / profile client state in {@link LocationSharingService},
 * using a fake native module. These prove the plumbing — local profile publish on init, invite
 * initiation with local auto-accept, incoming requests staying pending, a completed pair adding a
 * friend with reciprocal sharing enabled, profile events refreshing a friend, and polling cleanup on
 * shutdown — without a live iroh node.
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
    setPairingReady: [] as boolean[],
    importProfileTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    unsubscribe: [] as string[],
    shutdown: 0,
    pollPairEvents: 0,
    pollProfileEvents: 0,
    listPairSessions: 0,
    nearbyBlePeers: 0,
    bleCapabilities: 0,
  };

  // Drained-on-poll queues the test drives.
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
  profiles = new Map<string, ProfileView>();

  private handlers: Record<string, (e: unknown) => void> = {};

  async createNode() {
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  async start() {}
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
    return 'sess-invite';
  }
  async initiatePairNearby(peer: string) {
    this.calls.initiatePairNearby.push(peer);
    return 'sess-nearby';
  }
  async respondPair(sessionId: string, accept: boolean) {
    this.calls.respondPair.push({ sessionId, accept });
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

  it('creates an invite link and auto-accepts the local side when pairing from it', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    const link = await svc.createPairInvite(300);
    expect(link).toMatch(/^streetcryptid:\/\/social\?token=/);

    await svc.pairFromInput(link);
    expect(mockHolder.mod.calls.initiatePairByToken).toEqual(['scpair1:cafef00d']);
    expect(mockHolder.mod.calls.respondPair).toContainEqual({
      sessionId: 'sess-invite',
      accept: true,
    });
  });

  it('keeps an incoming pair request pending until the user responds', async () => {
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

    await svc.respondPair('incoming-1', true);
    expect(mockHolder.mod.calls.respondPair).toContainEqual({
      sessionId: 'incoming-1',
      accept: true,
    });
    expect(snap.current?.pairing.pendingRequests).toHaveLength(0);
  });

  it('automatically initiates the only verified nearby peer during a rub window', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.peers = [
      {
        deviceId: 'ble-one',
        phase: 'discovered',
        verifiedEndpointId: null,
        endpointHint: 'peer-nearby',
        consecutiveFailures: 0,
        connectPath: 'Gatt',
      },
    ];

    await svc.beginNearbyGesture();

    expect(mockHolder.mod.calls.initiatePairNearby).toEqual(['peer-nearby']);
    expect(mockHolder.mod.calls.respondPair).toContainEqual({
      sessionId: 'sess-nearby',
      accept: true,
    });
  });

  it('auto-accepts an inbound nearby request only inside the rub window', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.beginNearbyGesture();
    mockHolder.mod.pairEvents = [
      {
        kind: 'pendingRequest',
        sessionId: 'nearby-incoming',
        peerEndpointId: 'peer-nearby',
        nearby: true,
      },
    ];

    await svc.refreshPairing();

    expect(mockHolder.mod.calls.respondPair).toContainEqual({
      sessionId: 'nearby-incoming',
      accept: true,
    });
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

    await svc.beginNearbyGesture();
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-ready');
    expect(snap.current?.pairing.gestureActive).toBe(false);

    svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.pairing.discoveredFriend).toBeNull();
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-ready')).toBe(true);
    expect(snap.current?.sharingWith).toEqual(['peer-ready']);
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
