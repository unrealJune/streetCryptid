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

import {
  createTelemetry,
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';

import type { ContactCard } from '../../core/types';
import { BUMP_SEARCH_DURATION_MS } from '../../core/pairing-countdown';

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
    forgetSession: [] as string[],
    revokePairInvite: [] as string[],
    setPairingReady: [] as boolean[],
    importProfileTicket: [] as string[],
    publishIntroduction: [] as string[],
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
  ratchets = new Map<string, string>();
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
  cancelPairError: Error | null = null;
  forgetSessionError: Error | null = null;
  onCancelPair: ((sessionId: string) => void) | null = null;
  endpointId = 'aa11';
  initiateByTokenPromise: Promise<string> | null = null;
  bleAvailableAfterRestart = false;

  private handlers: Record<string, (e: unknown) => void> = {};

  async createNode() {
    this.calls.createNode += 1;
    if (this.calls.createNode > 1 && this.bleAvailableAfterRestart) {
      this.caps = { ...this.caps, available: true };
    }
    return {
      endpointId: this.endpointId,
      identitySecret: 'ii',
      recvSecret: 'rr',
      recvPublic: 'rp',
    };
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
  async publishIntroduction(subscriptionId: string) {
    this.calls.publishIntroduction.push(subscriptionId);
    return {
      accepted: true,
      rejection: null,
      enqueued: 1,
      published: 1,
      pending: 0,
      slotsSkipped: 0,
      overflowDropped: 0,
      suspended: false,
    };
  }
  async publish() {}
  async docsWrite() {}
  async syncLatest() {}
  async readLatest() {
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
      token: 'scpair2:cafef00d',
    };
  }
  async revokePairInvite(token: string) {
    this.calls.revokePairInvite.push(token);
    return true;
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
    if (this.cancelPairError) throw this.cancelPairError;
    const result = this.pairResults.get(sessionId);
    if (result && this.ratchets.get(result.peerEndpointId) === sessionId) {
      this.ratchets.delete(result.peerEndpointId);
    }
    // Native cancel tears the session down: drop it and its challenge.
    this.sessions = this.sessions.filter((s) => s.sessionId !== sessionId);
    this.challenges.delete(sessionId);
    this.pairResults.delete(sessionId);
    this.onCancelPair?.(sessionId);
  }
  async forgetSession(endpointId: string) {
    this.calls.forgetSession.push(endpointId);
    if (this.forgetSessionError) throw this.forgetSessionError;
    this.ratchets.delete(endpointId);
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
  radio: 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' = 'poweredOn';
  async bluetoothRadioState() {
    return this.radio;
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
import {
  LocationSharingService,
  profileBackfillDelayMs,
  type SharingSnapshot,
} from '../location-sharing';
// eslint-disable-next-line import/first
import * as persistence from '../persistence';

/**
 * A service started here owns a 4s pairing poll (and, once sharing is on, a live-request poll).
 * Jest tears the module registry down between test files but leaves the process — and its real
 * timers — alive, so a service left running fires into a dead registry and crashes an unrelated
 * suite. Every service a test starts gets shut down with it.
 */
const running: LocationSharingService[] = [];

function makeService(
  ...args: ConstructorParameters<typeof LocationSharingService>
): LocationSharingService {
  const svc = new LocationSharingService(...args);
  running.push(svc);
  return svc;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
});

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

/** Spans this service emitted, newest first. */
function poolSpans(action: string): ReturnType<typeof getEventLog> {
  return getEventLog().filter((entry) => entry.action === action);
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
  const svc = makeService();
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

async function discover(
  service: LocationSharingService,
  mod: FakeNativeModule,
  endpointId: string,
  sessionId = 'discovery'
): Promise<void> {
  mod.pairResults.set(
    sessionId,
    pairResult({
      sessionId,
      peerEndpointId: endpointId,
      peerProfile: profileView({ endpointId }),
    })
  );
  mod.ratchets.set(endpointId, sessionId);
  mod.sessions.push(
    verifyingSession({
      sessionId,
      peerEndpointId: endpointId,
      state: 'complete',
      localAccepted: true,
      peerAccepted: true,
      localSasConfirmed: true,
    })
  );
  mod.pairEvents.push({ kind: 'ready', sessionId, peerEndpointId: endpointId, nearby: false });
  await service.refreshPairing();
}

describe('LocationSharingService — pairing / profile wiring', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    // A real telemetry instance so the spans this file asserts on are the ones the service emits,
    // rather than a mock's idea of them. It writes to the in-memory event log only.
    resetEventLogForTesting();
    setTelemetryForTesting(createTelemetry({}));
  });

  afterEach(() => {
    while (services.length) services.pop()?.shutdown();
    setTelemetryForTesting(undefined);
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
    expect(link).toMatch(/^https:\/\/streetcrypt\.id\/pair#token=/);

    await svc.pairFromInput(link);
    expect(mockHolder.mod.calls.initiatePairByToken).toEqual(['scpair2:cafef00d']);
    // SAS is mandatory: initiating must NOT auto-accept the local side.
    expect(mockHolder.mod.calls.respondPair).toHaveLength(0);
  });

  it('retires the link it minted once another phone has opened it', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(300);

    // A redemption creates a session keyed by the INVITE id — that is how this side learns the
    // link was used at all, and the whole reason the id is retained.
    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'iid', state: 'handshaking', sasVerified: false }),
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.inviteRedeemed).toBe(true);

    // Once that attempt is over the token is withdrawn outright: native would still honour a
    // retry from the bound peer, but a link the user watched fail is not one to keep handing out.
    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'iid', state: 'failed', sasVerified: false }),
    ];
    await svc.refreshPairing();
    expect(mockHolder.mod.calls.revokePairInvite).toEqual(['scpair2:cafef00d']);
    expect(snap.current?.pairing.inviteLink).toBeNull();
    // The latch outlives the link, so the screen can still say WHY it went.
    expect(snap.current?.pairing.inviteRedeemed).toBe(true);
  });

  it('revokes a cancelled link at its issuer and clears the offer', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(120);

    await expect(svc.cancelPairInvite()).resolves.toBe('cancelled');
    expect(mockHolder.mod.calls.revokePairInvite).toEqual(['scpair2:cafef00d']);
    expect(snap.current?.pairing).toMatchObject({
      inviteLink: null,
      inviteExpiresAt: null,
      inviteRedeemed: false,
    });
    await expect(svc.cancelPairInvite()).resolves.toBe('absent');
  });

  it('cancels a redemption that raced the link cancellation', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(120);
    mockHolder.mod.sessions = [verifyingSession({ sessionId: 'iid', peerEndpointId: 'peer-race' })];
    mockHolder.mod.challenges.set('iid', sasChallenge());

    await svc.cancelPairInvite();

    expect(mockHolder.mod.calls.cancelPair).toEqual(['iid']);
    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.sharingWith).toEqual([]);
    expect(snap.current?.pairing.verifications).toEqual([]);
  });

  it('does not claim a link was cancelled when revocation is unavailable or failed', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    const link = await svc.createPairInvite(120);
    const revoke = mockHolder.mod.revokePairInvite;
    Object.assign(mockHolder.mod, { revokePairInvite: undefined });

    await expect(svc.cancelPairInvite()).resolves.toBe('unsupported');
    expect(snap.current?.pairing.inviteLink).toBe(link);
    mockHolder.mod.revokePairInvite = revoke;
    jest.spyOn(mockHolder.mod, 'revokePairInvite').mockRejectedValueOnce(new Error('native busy'));
    await expect(svc.cancelPairInvite()).rejects.toThrow('native busy');
    expect(snap.current?.pairing.inviteLink).toBe(link);
    await expect(svc.cancelPairInvite()).resolves.toBe('cancelled');
  });

  it('waits for an in-flight mint before cancelling so a late link cannot escape revocation', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    const invite = await mockHolder.mod.createPairInvite(120);
    let finishMint!: (invite: PairInviteWithToken) => void;
    jest.spyOn(mockHolder.mod, 'createPairInvite').mockReturnValueOnce(
      new Promise((resolve) => {
        finishMint = resolve;
      })
    );
    const mint = svc.createPairInvite(120);
    const cancel = svc.cancelPairInvite();
    finishMint(invite);

    await mint;
    await expect(cancel).resolves.toBe('cancelled');
    expect(mockHolder.mod.calls.revokePairInvite).toEqual([invite.token]);
    expect(snap.current?.pairing.inviteLink).toBeNull();
  });

  it('does not clear a replacement invite when an earlier cancellation finishes', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(120);
    let finishRevoke!: (revoked: boolean) => void;
    jest.spyOn(mockHolder.mod, 'revokePairInvite').mockReturnValueOnce(
      new Promise((resolve) => {
        finishRevoke = resolve;
      })
    );
    const nextInvite = {
      ...(await mockHolder.mod.createPairInvite(120)),
      inviteId: 'replacement',
      token: 'scpair2:decafbad',
    };
    jest.spyOn(mockHolder.mod, 'createPairInvite').mockResolvedValueOnce(nextInvite);
    const cancel = svc.cancelPairInvite();
    const mint = svc.createPairInvite(120);
    finishRevoke(true);

    await cancel;
    const nextLink = await mint;
    expect(snap.current?.pairing.inviteLink).toBe(nextLink);
    expect(snap.current?.pairing.inviteRedeemed).toBe(false);
  });

  it('leaves an untouched link alone', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(300);

    mockHolder.mod.sessions = [verifyingSession({ sessionId: 'someone-elses-session' })];
    await svc.refreshPairing();

    expect(snap.current?.pairing.inviteRedeemed).toBe(false);
    expect(snap.current?.pairing.inviteLink).toMatch(/token=/);
    expect(mockHolder.mod.calls.revokePairInvite).toHaveLength(0);
  });

  it('does not let a spent latch follow this phone onto the next link', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.createPairInvite(300);
    mockHolder.mod.sessions = [verifyingSession({ sessionId: 'iid', state: 'failed' })];
    await svc.refreshPairing();
    expect(snap.current?.pairing.inviteRedeemed).toBe(true);

    await svc.createPairInvite(300);
    expect(snap.current?.pairing.inviteRedeemed).toBe(false);
  });

  it('records a pairing that broke, instead of quietly forgetting it', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairEvents = [
      { kind: 'failed', sessionId: 'sess-dead', peerEndpointId: 'peerX', nearby: true },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.failure).toMatchObject({
      sessionId: 'sess-dead',
      reason: 'lost',
      nearby: true,
      verified: false,
    });
  });

  it('distinguishes a refused visual check from a session that never reached one', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.challenges.set('sess-sas', sasChallenge({ role: 'displayer' }));
    mockHolder.mod.pairEvents = [
      { kind: 'verifying', sessionId: 'sess-sas', peerEndpointId: 'peerY', nearby: false },
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.verifications).toHaveLength(1);

    mockHolder.mod.pairEvents = [
      { kind: 'rejected', sessionId: 'sess-sas', peerEndpointId: 'peerY', nearby: false },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.failure).toMatchObject({ reason: 'declined', verified: true });
    expect(snap.current?.pairing.verifications).toHaveLength(0);
  });

  it('retires the recorded failure as soon as anything starts again', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.pairEvents = [
      { kind: 'failed', sessionId: 'sess-dead', peerEndpointId: 'peerX', nearby: true },
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.failure).not.toBeNull();

    mockHolder.mod.pairEvents = [
      { kind: 'pendingRequest', sessionId: 'sess-new', peerEndpointId: 'peerZ', nearby: true },
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.failure).toBeNull();
  });

  it('moves directly from an armed bump window into link redemption', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    await svc.armBump();

    await svc.pairFromInput('scpair2:cafef00d');

    expect(mockHolder.mod.calls.setPairingReady).toEqual([true, false]);
    expect(mockHolder.mod.calls.initiatePairByToken).toEqual(['scpair2:cafef00d']);
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

  it('standing down cancels a live session but spares one that has completed', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');

    // What the screen holds: two sessions it believed were in flight when it last rendered.
    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-live', peerEndpointId: 'peer-live' }),
      verifyingSession({ sessionId: 'sess-done', peerEndpointId: 'peer-done', state: 'complete' }),
    ];

    await svc.standDownPairing(['sess-live', 'sess-done']);

    // The regression: the screen's list is a poll old, so a pair that completed inside that poll
    // used to be cancelled on the way out — sending the peer a Reject for a pairing that had
    // already succeeded, and leaving exactly one of the two phones with a friend.
    expect(mockHolder.mod.calls.cancelPair).toEqual(['sess-live']);
  });

  it('standing down ignores sessions native no longer knows about', async () => {
    const svc = newService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.sessions = [];

    await svc.standDownPairing(['sess-vanished']);

    expect(mockHolder.mod.calls.cancelPair).toEqual([]);
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

  it('exposes the exact native search start, separate from the armed window', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await svc.armBump();
    let finishSearch!: (resolution: BumpResolution) => void;
    mockHolder.mod.bumpResolutionPromise = new Promise((resolve) => {
      finishSearch = resolve;
    });
    const resolvePeer = jest.spyOn(mockHolder.mod, 'resolveBumpPeer');
    const before = Date.now();
    const search = svc.commitBump();
    const after = Date.now();
    expect(snap.current?.pairing.bump.searchStartedAt).toBeGreaterThanOrEqual(before);
    expect(snap.current?.pairing.bump.searchStartedAt).toBeLessThanOrEqual(after);
    expect(snap.current?.pairing.bump.expiresAt).toBeGreaterThan(after + BUMP_SEARCH_DURATION_MS);
    expect(resolvePeer).toHaveBeenCalledWith(BUMP_SEARCH_DURATION_MS);
    finishSearch(mockHolder.mod.bumpResolution);
    await search;
    expect(snap.current?.pairing.bump.searchStartedAt).toBeNull();
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

  it('keeps a ready friend private until the discovery is explicitly acknowledged', async () => {
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

    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.sharingWith).toEqual([]);
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-ready');
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-ready')).toBe(false);

    await svc.armBump();
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-ready');
    expect(snap.current?.pairing.bump.stage).toBe('idle');

    await svc.acknowledgeDiscoveredFriend();
    // The friend exists the moment ACKNOWLEDGE returns — the subscribe/introduction wiring is
    // deliberately NOT awaited by it (see `decideDiscovery`), so the assertions below that reach
    // the network wait for it explicitly.
    const friend = snap.current?.friends.find((f) => f.endpointId === 'peer-ready');
    expect(friend).toBeDefined();
    expect(friend?.handle).toBe('@fresh'); // verified profile applied
    expect(friend?.profileEpoch).toBe(300);
    expect(snap.current?.sharingWith).toEqual(['peer-ready']);
    expect(friend?.pairingSessionId).toBe('sess-ready');
    // Subscribed + profile-imported via the normal friend path.
    await svc.awaitFriendWiring();
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-ready')).toBe(true);
    expect(
      mockHolder.mod.calls.subscribe.some(
        (s) => s.topic === 'topic-aa11' && s.bootstrap.includes('peer-ticket')
      )
    ).toBe(true);
    expect(mockHolder.mod.calls.importProfileTicket).toContain('peer-profile');

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
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-recover');
    await svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.friends.some((friend) => friend.endpointId === 'peer-recover')).toBe(true);

    const callsAfterRecovery = mockHolder.mod.calls.pairResult.length;
    await svc.refreshPairing();
    expect(mockHolder.mod.calls.pairResult).toHaveLength(callsAfterRecovery);
  });

  it('requires both the SAS gate and discovery acknowledgement before creating the grant', async () => {
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

    // 3) Native Ready permits the discovery; it does not yet grant location access.
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

    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.sharingWith).toEqual([]);
    await svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-v2r')).toBe(true);
    expect(snap.current?.sharingWith).toEqual(['peer-v2r']);
    expect(snap.current?.pairing.verifications).toHaveLength(0);
  });

  it('rejects a discovery without ever adding, subscribing to, or sharing with that friend', async () => {
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
    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.sharingWith).toEqual([]);

    await svc.rejectDiscoveredFriend();

    expect(snap.current?.pairing.discoveredFriend).toBeNull();
    expect(snap.current?.friends.some((f) => f.endpointId === 'peer-rejected')).toBe(false);
    expect(snap.current?.sharingWith).toEqual([]);
    expect(mockHolder.mod.calls.cancelPair).toContain('sess-rejected');
    expect(mockHolder.mod.calls.forgetSession).not.toContain('peer-rejected');
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-rejected')).toBe(
      false
    );
  });

  it('does not resurrect a rejected discovery from a stale completion or late profile', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'peer-replay');
    await svc.rejectDiscoveredFriend();
    mockHolder.mod.profileEvents.push(profileView({ endpointId: 'peer-replay', epoch: 900 }));
    await discover(svc, mockHolder.mod, 'peer-replay');
    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.sharingWith).toEqual([]);
    expect(snap.current?.pairing.discoveredFriend).toBeNull();
  });

  it('withdraws on both phones when one acknowledges before the other rejects', async () => {
    const aliceMod = mockHolder.mod;
    const alice = newService();
    const aliceSnap = watch(alice);
    await alice.init('@alice', 'mothman');

    const bobMod = new FakeNativeModule();
    bobMod.endpointId = 'bb22';
    mockHolder.mod = bobMod;
    const bob = newService();
    const bobSnap = watch(bob);
    await bob.init('@bob', 'mothman');
    bobMod.onCancelPair = (sessionId) => {
      if (aliceMod.ratchets.get('bb22') === sessionId) aliceMod.ratchets.delete('bb22');
      aliceMod.pairEvents.push({
        kind: 'rejected',
        sessionId,
        peerEndpointId: 'bb22',
        nearby: false,
      });
    };
    await discover(alice, aliceMod, 'bb22');
    await discover(bob, bobMod, 'aa11');
    await alice.acknowledgeDiscoveredFriend();
    expect(aliceSnap.current?.sharingWith).toEqual(['bb22']);
    await bob.rejectDiscoveredFriend();
    await alice.refreshPairing();
    expect(aliceSnap.current?.friends).toEqual([]);
    expect(bobSnap.current?.friends).toEqual([]);
    expect(aliceSnap.current?.sharingWith).toEqual([]);
    expect(bobSnap.current?.sharingWith).toEqual([]);
    expect(aliceSnap.current?.pairing.failure?.withdrawn).toBe(true);
    expect(aliceMod.ratchets.has('bb22')).toBe(false);
    expect(bobMod.ratchets.has('aa11')).toBe(false);
    expect(aliceMod.calls.forgetSession).toEqual([]);
    expect(bobMod.calls.forgetSession).toEqual([]);
  });

  it('keeps other pending discoveries and accepted friends when one discovery is rejected', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'first', 'first-session');
    await discover(svc, mockHolder.mod, 'second', 'second-session');
    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('first');
    await svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('second');
    await svc.rejectDiscoveredFriend();
    expect(snap.current?.friends.map((friend) => friend.endpointId)).toEqual(['first']);
    expect(snap.current?.sharingWith).toEqual(['first']);
  });

  it('does not remove a newer pairing when an older pairing is withdrawn', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'same-peer', 'old-session');
    await svc.acknowledgeDiscoveredFriend();
    await discover(svc, mockHolder.mod, 'same-peer', 'new-session');
    await svc.acknowledgeDiscoveredFriend();
    mockHolder.mod.pairEvents.push({
      kind: 'rejected',
      sessionId: 'old-session',
      peerEndpointId: 'same-peer',
      nearby: false,
    });
    await svc.refreshPairing();
    expect(snap.current?.friends[0]?.pairingSessionId).toBe('new-session');
    expect(snap.current?.sharingWith).toEqual(['same-peer']);
    expect(mockHolder.mod.calls.forgetSession).not.toContain('same-peer');
  });

  it('keeps a failed rejection visible and retryable without permitting acknowledgement', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'peer-retry');
    mockHolder.mod.cancelPairError = new Error('could not cancel');
    await expect(svc.rejectDiscoveredFriend()).rejects.toThrow('could not cancel');
    expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-retry');
    expect(snap.current?.friends).toEqual([]);
    await expect(svc.acknowledgeDiscoveredFriend()).rejects.toThrow('was rejected');
    mockHolder.mod.cancelPairError = null;
    await svc.rejectDiscoveredFriend();
    expect(snap.current?.pairing.discoveredFriend).toBeNull();
    expect(snap.current?.friends).toEqual([]);
  });

  it('does not turn generic route teardown into completed-pair withdrawal', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'kept-peer');
    await svc.acknowledgeDiscoveredFriend();
    await svc.cancelPair('discovery');
    expect(mockHolder.mod.calls.cancelPair).toEqual([]);
    expect(snap.current?.friends[0]?.endpointId).toBe('kept-peer');
    expect(snap.current?.pairing.completedSessionIds).toContain('discovery');
  });

  it.each([true, false])(
    'keeps an existing friend when a fresh reused-ID SAS attempt is rejected (event=%s)',
    async (withVerifyingEvent) => {
      const svc = newService();
      const snap = watch(svc);
      await svc.init('@me', 'mothman');
      await discover(svc, mockHolder.mod, 'known-peer', 'nearby-id');
      await svc.acknowledgeDiscoveredFriend();
      mockHolder.mod.sessions = [
        verifyingSession({ sessionId: 'nearby-id', peerEndpointId: 'known-peer', nearby: true }),
      ];
      mockHolder.mod.challenges.set('nearby-id', sasChallenge());
      if (withVerifyingEvent) {
        mockHolder.mod.pairEvents.push({
          kind: 'verifying',
          sessionId: 'nearby-id',
          peerEndpointId: 'known-peer',
          nearby: true,
        });
      }
      await svc.refreshPairing();
      expect(snap.current?.pairing.completedSessionIds).not.toContain('nearby-id');
      mockHolder.mod.sessions = [{ ...mockHolder.mod.sessions[0], state: 'rejected' }];
      mockHolder.mod.challenges.clear();
      mockHolder.mod.pairEvents.push({
        kind: 'rejected',
        sessionId: 'nearby-id',
        peerEndpointId: 'known-peer',
        nearby: true,
      });
      await svc.refreshPairing();
      expect(snap.current?.friends[0]?.endpointId).toBe('known-peer');
      expect(snap.current?.sharingWith).toEqual(['known-peer']);
      expect(mockHolder.mod.calls.forgetSession).toEqual([]);
      expect(mockHolder.mod.ratchets.has('known-peer')).toBe(true);
    }
  );

  it('does not erase a newer ratchet when rejecting an older queued discovery', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'same-peer', 'old-discovery');
    await discover(svc, mockHolder.mod, 'same-peer', 'new-discovery');
    await svc.rejectDiscoveredFriend();
    expect(mockHolder.mod.calls.cancelPair).toEqual(['old-discovery']);
    expect(mockHolder.mod.calls.forgetSession).toEqual([]);
    expect(mockHolder.mod.ratchets.get('same-peer')).toBe('new-discovery');
    expect(snap.current?.pairing.discoveredFriend?.pairingSessionId).toBe('new-discovery');
    await svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.friends[0]?.pairingSessionId).toBe('new-discovery');
  });

  it('preserves a newer discovery when the peer withdraws an older acknowledged pairing', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'same-peer', 'old-accepted');
    await svc.acknowledgeDiscoveredFriend();
    await discover(svc, mockHolder.mod, 'same-peer', 'new-pending');
    mockHolder.mod.pairEvents.push({
      kind: 'rejected',
      sessionId: 'old-accepted',
      peerEndpointId: 'same-peer',
      nearby: false,
    });
    await svc.refreshPairing();
    expect(snap.current?.friends).toEqual([]);
    expect(snap.current?.pairing.discoveredFriend?.pairingSessionId).toBe('new-pending');
    expect(mockHolder.mod.ratchets.get('same-peer')).toBe('new-pending');
    expect(mockHolder.mod.calls.forgetSession).toEqual([]);
    await svc.acknowledgeDiscoveredFriend();
    expect(snap.current?.friends[0]?.pairingSessionId).toBe('new-pending');
  });

  it('does not share or dismiss the discovery when saving acknowledgement fails', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'peer-save');
    const save = jest.spyOn(persistence, 'savePool').mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(svc.acknowledgeDiscoveredFriend()).rejects.toThrow('disk full');
      expect(snap.current?.friends).toEqual([]);
      expect(snap.current?.sharingWith).toEqual([]);
      expect(snap.current?.pairing.discoveredFriend?.endpointId).toBe('peer-save');
      expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-save')).toBe(false);
      await svc.acknowledgeDiscoveredFriend();
      expect(snap.current?.friends[0]?.endpointId).toBe('peer-save');
    } finally {
      save.mockRestore();
    }
  });

  it('serializes an in-flight acknowledgement write ahead of its newer rejection', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await discover(svc, mockHolder.mod, 'peer-write-race');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSave = persistence.savePool;
    const save = jest.spyOn(persistence, 'savePool').mockImplementationOnce(async (kv, state) => {
      await gate;
      await originalSave(kv, state);
    });
    try {
      const accepting = svc.acknowledgeDiscoveredFriend();
      const accepted = expect(accepting).rejects.toThrow('other phone rejected');
      await new Promise((resolve) => setTimeout(resolve, 0));
      mockHolder.mod.pairEvents.push({
        kind: 'rejected',
        sessionId: 'discovery',
        peerEndpointId: 'peer-write-race',
        nearby: false,
      });
      const rejecting = svc.refreshPairing();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(save).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([accepted, rejecting]);
      expect(snap.current?.friends).toEqual([]);
      expect(snap.current?.sharingWith).toEqual([]);
      expect((await persistence.loadPool(save.mock.calls[0][0]))?.friends).toEqual({});
      expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-peer-write-race')).toBe(
        false
      );
    } finally {
      release();
      save.mockRestore();
    }
  });

  it('shows a placeholder discovery when the pair has no verified profile yet', async () => {
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

    const friend = snap.current?.pairing.discoveredFriend;
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

  it('keeps a profile that lands in the same drain as the pair it belongs to', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // Both native queues are drained together, and `finalize` imports the peer's profile
    // namespace before it queues `ready` — so the profile really can share a batch with it.
    mockHolder.mod.pairResults.set(
      'sess-same',
      pairResult({ sessionId: 'sess-same', peerEndpointId: 'ccddeeff', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-same', peerEndpointId: 'ccddeeff', nearby: true },
    ];
    mockHolder.mod.profileEvents = [
      profileView({ endpointId: 'ccddeeff', epoch: 700, handle: '@bumped', sigil: 'wendigo' }),
    ];
    await svc.refreshPairing();

    const friend = snap.current?.pairing.discoveredFriend;
    expect(friend?.handle).toBe('@bumped');
    expect(friend?.sigil).toBe('wendigo');
    expect(friend?.profileEpoch).toBe(700);
  });

  it('holds a profile that arrives a poll before its pair completes', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // Profile first, with no friend to attach it to. The native queue is drained one-shot, so
    // dropping it here used to cost the persona until the next relaunch.
    mockHolder.mod.profileEvents = [
      profileView({ endpointId: 'ddeeff00', epoch: 800, handle: '@early', sigil: 'chupacabra' }),
    ];
    await svc.refreshPairing();
    expect(snap.current?.friends.find((f) => f.endpointId === 'ddeeff00')).toBeUndefined();

    mockHolder.mod.pairResults.set(
      'sess-late',
      pairResult({ sessionId: 'sess-late', peerEndpointId: 'ddeeff00', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-late', peerEndpointId: 'ddeeff00', nearby: true },
    ];
    await svc.refreshPairing();

    const friend = snap.current?.pairing.discoveredFriend;
    expect(friend?.handle).toBe('@early');
    expect(friend?.sigil).toBe('chupacabra');
    expect(friend?.profileEpoch).toBe(800);
  });

  it('opens the SAS gate before the profile backfill, not behind it', async () => {
    // Regression, 2026-09-10: "extremely slow (like 1 minute) to open the SAS screen", on link
    // pairing and on bump. `backfillMissingProfiles` ran in the middle of the pairing poll, ahead
    // of `reconcileVerifications` and the emit — so an unbounded walk that dials a namespace per
    // friend sat between `verifying` landing in the native queue and the screen that renders it.
    // `pollInFlight` meant the 4s timer could not slip past either: the next poll did not start
    // until this one returned. Measured `pairing.poll` spans of 47-131s on the stuck side.
    //
    // The backfill is best-effort cosmetics — a handle and a sigil — so it now runs last.
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // A friend with a profile ticket and no epoch is what the sweep goes dialling for.
    mockHolder.mod.pairResults.set(
      'sess-slow',
      pairResult({ sessionId: 'sess-slow', peerEndpointId: 'aabb1122', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-slow', peerEndpointId: 'aabb1122', nearby: true },
    ];
    await svc.refreshPairing();
    mockHolder.mod.pairEvents = [];

    // Now wedge the sweep, exactly as a peer asleep in a pocket does.
    let release = () => {};
    const wedged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const importTicket = mockHolder.mod.importProfileTicket.bind(mockHolder.mod);
    mockHolder.mod.importProfileTicket = async (ticket: string) => {
      await importTicket(ticket);
      await wedged;
    };

    mockHolder.mod.sessions = [
      verifyingSession({ sessionId: 'sess-sas', peerEndpointId: 'peerSAS', nearby: true }),
    ];
    mockHolder.mod.challenges.set(
      'sess-sas',
      sasChallenge({ role: 'picker', targetIndex: 1, optionIndices: [0, 1, 2] })
    );

    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    try {
      const polling = svc.refreshPairing();
      // One macrotask is enough to drain every resolved await up to the wedge.
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The gate is on screen while the backfill is still hanging — the whole point.
      expect(snap.current?.pairing.verifications.map((v) => v.sessionId)).toEqual(['sess-sas']);
      expect(mockHolder.mod.calls.importProfileTicket).toContain('peer-profile');

      release();
      await polling;
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('backs the profile retry off from one second, capped', () => {
    // The first attempt is immediate; these are the gaps after it. The cap is what keeps ten
    // attempts inside the few minutes the bounded retry is documented to cover.
    expect(profileBackfillDelayMs(1)).toBe(1_000);
    expect(profileBackfillDelayMs(2)).toBe(2_000);
    expect(profileBackfillDelayMs(3)).toBe(4_000);
    expect(profileBackfillDelayMs(10)).toBe(60_000);
    expect(profileBackfillDelayMs(0)).toBe(1_000);
  });

  // Regression, 2026-09-13: a pair completed at 21:50:55 and the persona did not land until
  // 21:51:20 — the reveal having given up at 21:51:07. Nothing was slow; the retry was simply not
  // allowed to run. The sweep stamped ONE clock the instant its gate opened, before checking
  // whether any friend needed work, so the pass that ran against an empty pool at launch spent
  // the quota and the pair that completed seconds later served out the remainder.
  it('retries a personaless pair at once, and paces each friend on their own clock', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    // An empty-pool sweep at launch must cost a later pair nothing.
    await svc.refreshPairing();
    mockHolder.mod.calls.importProfileTicket.length = 0;

    mockHolder.mod.pairResults.set(
      'sess-a',
      pairResult({ sessionId: 'sess-a', peerEndpointId: 'aaaa0001', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-a', peerEndpointId: 'aaaa0001', nearby: true },
    ];
    await svc.refreshPairing();

    // The reveal is on screen now, so the first re-dial happens now — not on the next sweep.
    expect(mockHolder.mod.calls.importProfileTicket).toContain('peer-profile');

    // A second friend paired immediately after must not inherit the first one's backoff. The
    // first is acknowledged so the second becomes the discovery on screen.
    await svc.acknowledgeDiscoveredFriend();
    mockHolder.mod.calls.importProfileTicket.length = 0;
    mockHolder.mod.profiles.set(
      'bbbb0002',
      profileView({ endpointId: 'bbbb0002', epoch: 5, handle: '@second', sigil: 'wendigo' })
    );
    mockHolder.mod.pairResults.set(
      'sess-b',
      pairResult({ sessionId: 'sess-b', peerEndpointId: 'bbbb0002', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-b', peerEndpointId: 'bbbb0002', nearby: true },
    ];
    await svc.refreshPairing();

    expect(snap.current?.pairing.discoveredFriend?.handle).toBe('@second');
  });

  // A sealed envelope is readable only by the recipients it was sealed FOR, so a new friend can
  // open nothing published before they existed. Without an introduction their first sight of you
  // is the next scheduled publish — p50 5 min / p90 92 min / 17 h tail on a parked iPhone.
  describe('introducing yourself to a new friend', () => {
    async function pairAndWatch() {
      const svc = newService();
      const snap = watch(svc);
      await svc.init('@me', 'mothman');
      mockHolder.mod.pairResults.set(
        'sess-hello',
        pairResult({ sessionId: 'sess-hello', peerEndpointId: 'cc330099', peerProfile: null })
      );
      mockHolder.mod.pairEvents = [
        { kind: 'ready', sessionId: 'sess-hello', peerEndpointId: 'cc330099', nearby: true },
      ];
      await svc.refreshPairing();
      mockHolder.mod.pairEvents = [];
      return { svc, snap };
    }

    // The consent argument, and the reason this does not hang off `onPairReady`. Pairing ARMS
    // sharing, but the reveal screen still offers REJECT and `rejectDiscoveredFriend` revokes —
    // so nothing may go out until the human says keep.
    it('sends nothing while the reveal is still on screen', async () => {
      const { snap } = await pairAndWatch();
      expect(snap.current?.pairing?.discoveredFriend?.endpointId).toBe('cc330099');
      expect(mockHolder.mod.calls.publishIntroduction).toHaveLength(0);
    });

    it('seals the last known position once the friend is acknowledged', async () => {
      const { svc } = await pairAndWatch();
      await svc.acknowledgeDiscoveredFriend();
      await svc.awaitFriendWiring();

      expect(mockHolder.mod.calls.publishIntroduction).toHaveLength(1);
    });

    // THE regression from 2026-09-17 00:50 UTC. `subscribeToFriend` was awaited by ACKNOWLEDGE,
    // and it held the node-wide native lock across a dial to an internet-unreachable peer — so the
    // acknowledge promise never settled, `pool.friend_added` was never recorded, the pairing poll
    // stopped within the second, and the phone needed a force-quit. The peer gave up and
    // unfriended a minute later.
    //
    // A friend is a local decision. Nothing the network does may stand between the human saying
    // "keep this one" and the app having kept them.
    it('adopts the friend even when the network wiring never comes back', async () => {
      const { svc, snap } = await pairAndWatch();
      // A subscribe that never settles — not one that rejects. A rejection would have been
      // reported and moved on; it is the pending-forever case that wedged the app.
      mockHolder.mod.subscribe = () => new Promise<string>(() => {});

      await svc.acknowledgeDiscoveredFriend();

      expect(snap.current?.friends.some((f) => f.endpointId === 'cc330099')).toBe(true);
      expect(snap.current?.sharingWith).toEqual(['cc330099']);
      expect(snap.current?.pairing.discoveredFriend).toBeNull();
      // And the pool change is on the record. `pool.friend_added` is emitted AFTER the wiring
      // used to be awaited, so on 2026-09-17 a wedged acknowledge left no trace of itself at all.
      expect(poolSpans('pool.friend_added')[0]?.details).toMatchObject({
        attributes: expect.objectContaining({ reason: 'pair-acknowledged', friends: 1 }),
      });
    });

    it('sends nothing when the friend is rejected instead', async () => {
      const { svc } = await pairAndWatch();
      await svc.rejectDiscoveredFriend();

      expect(mockHolder.mod.calls.publishIntroduction).toHaveLength(0);
    });

    // A friend vanishing seconds after a successful pair is indistinguishable, in the data, from
    // a pair that silently failed — unless the removal says who asked for it. It did not, and on
    // 2026-09-13 that cost an afternoon deciding whether REJECT had been pressed at all.
    it('records why the friend was dropped, distinctly from a manual removal', async () => {
      const { svc } = await pairAndWatch();
      // Nothing joins the pool on `ready` — the acknowledgement is the add, and says so.
      expect(poolSpans('pool.friend_added')).toHaveLength(0);

      await svc.acknowledgeDiscoveredFriend();
      expect(poolSpans('pool.friend_added')[0]?.details).toMatchObject({
        attributes: expect.objectContaining({
          reason: 'pair-acknowledged',
          'sc.peer': 'cc330099',
        }),
      });

      // The peer's late `rejected` for that same session is the one path that withdraws a friend
      // who was already in the pool, and it must not read as someone using remove-friend.
      mockHolder.mod.pairEvents = [
        { kind: 'rejected', sessionId: 'sess-hello', peerEndpointId: 'cc330099', nearby: true },
      ];
      await svc.refreshPairing();

      expect(poolSpans('pool.friend_removed')[0]?.details).toMatchObject({
        attributes: expect.objectContaining({ reason: 'peer-reject', friends: 0 }),
      });
    });

    // A phone can be running an older binary than the JS bundle — the export simply is not there.
    it('is silent on a binary that predates the native half', async () => {
      const { svc } = await pairAndWatch();
      delete (mockHolder.mod as { publishIntroduction?: unknown }).publishIntroduction;
      expect(() => svc.acknowledgeDiscoveredFriend()).not.toThrow();
    });
  });

  it('re-arms replication for a friend paired without a profile', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // The pair completes with no verified profile — the usual outcome, since the peer's namespace
    // has only just been imported — and no profile event ever follows, which is what a one-way
    // sync failure looks like from this side.
    mockHolder.mod.pairResults.set(
      'sess-dry',
      pairResult({ sessionId: 'sess-dry', peerEndpointId: 'eeff0011', peerProfile: null })
    );
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 'sess-dry', peerEndpointId: 'eeff0011', nearby: true },
    ];
    await svc.refreshPairing();
    expect(snap.current?.pairing.discoveredFriend?.handle).toBe('@eeff0011');

    // A later sweep re-imports the ticket, which re-dials the addresses in it. This time the
    // replica has the record.
    mockHolder.mod.profiles.set(
      'eeff0011',
      profileView({ endpointId: 'eeff0011', epoch: 900, handle: '@late', sigil: 'skinwalker' })
    );
    mockHolder.mod.calls.importProfileTicket.length = 0;
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 60_000);
    try {
      await svc.refreshPairing();
    } finally {
      nowSpy.mockRestore();
    }

    expect(mockHolder.mod.calls.importProfileTicket).toContain('peer-profile');
    const friend = snap.current?.pairing.discoveredFriend;
    expect(friend?.handle).toBe('@late');
    expect(friend?.profileEpoch).toBe(900);
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
    expect(snap.current?.pairing.radio).toBe('poweredOn');
  });

  // Arming with the radio off used to succeed: the window opened, the sensor fired, and the
  // resolve came back empty with nothing pointing at Bluetooth.
  it('refuses to arm Bump while the Bluetooth radio is off', async () => {
    const svc = newService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    mockHolder.mod.radio = 'poweredOff';

    await expect(svc.armBump()).rejects.toThrow(/Bluetooth is off/);
    await svc.refreshPairing();
    expect(snap.current?.pairing.radio).toBe('poweredOff');
    expect(snap.current?.pairing.bump.stage).toBe('idle');
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

    const pairing = svc.pairFromInput('scpair2:slow');
    await Promise.resolve();
    await expect(svc.ensureBleReady()).rejects.toThrow(/pairing action/i);
    expect(mockHolder.mod.calls.shutdown).toBe(0);

    resolveSession('sess-slow');
    await pairing;
  });

  it('polls a live bump from one driver, not two', async () => {
    // Tempo, 2026-09-17 04:03-04:04 UTC: 6-7 `pairing.poll` spans PER SECOND on the iPhone being
    // bumped and 2-3/s on the Pixel bumping it. Two 300ms drivers were running the same drain —
    // this loop, re-armed fast because a session was live, and Bump's own `setInterval` — and
    // each pass is six crossings of the native bridge that take the pairing locks the handshake
    // itself needs. That bump took 44s from armed to SAS gate.
    //
    // The cadence is the point, so this asserts the RATE, not the absence of an interval: sampling
    // stays sub-second while a bump is up (the handshake is ~390ms of machine time), and one
    // driver means roughly one poll per PAIRING_ACTIVE_POLL_INTERVAL_MS rather than two.
    jest.useFakeTimers();
    try {
      const svc = makeService();
      await svc.init('@me', 'mothman');
      await jest.advanceTimersByTimeAsync(0);

      await svc.armBump();
      const armed = mockHolder.mod.calls.pollPairEvents;
      await jest.advanceTimersByTimeAsync(3000);
      const polls = mockHolder.mod.calls.pollPairEvents - armed;

      // 3s at a 300ms cadence is ~10 passes from one driver and ~20 from two. The window is wide
      // on both sides: this is a guard against a duplicate driver, not a metronome test.
      expect(polls).toBeGreaterThanOrEqual(5);
      expect(polls).toBeLessThanOrEqual(14);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops polling after shutdown', async () => {
    jest.useFakeTimers();
    try {
      const svc = makeService();
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

  it('surfaces a pairing session without waiting on a slow BLE read', async () => {
    // The regression this guards: `listPairSessions()` used to share a Promise.all with the
    // three BLE calls, and Promise.all resolves at its SLOWEST member -- so the SAS gate waited
    // on a Bluetooth query unrelated to the handshake. `pollPairingOnce` also coalesces on
    // `pollInFlight`, so the next tick returned the same stuck promise rather than re-reading,
    // and one slow BLE call stalled every pairing update for its full duration. Observed in
    // production as polls of 10-17s while the native handshake itself takes ~390ms.
    const svc = newService();
    await svc.init('@me', 'mothman');

    const seen = watch(svc);
    const mod = mockHolder.mod;
    mod.sessions = [verifyingSession({ sessionId: 'sess-slow-ble' })];

    let releaseBle: () => void = () => {};
    const bleBlocked = new Promise<void>((resolve) => {
      releaseBle = resolve;
    });
    const realCapabilities = mod.bleCapabilities.bind(mod);
    mod.bleCapabilities = async () => {
      await bleBlocked;
      return realCapabilities();
    };

    // Drive exactly one poll. The BLE half cannot settle until `releaseBle`, so anything the
    // snapshot knows before then arrived without waiting on Bluetooth.
    const polling = (svc as unknown as { pollPairingOnce(): Promise<void> }).pollPairingOnce();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    expect(seen.current?.pairing.sessions.map((session) => session.sessionId)).toContain(
      'sess-slow-ble'
    );

    releaseBle();
    await polling;
  });
});
