/**
 * A fake `iroh-location` native module for the pairing-side service tests: drained-on-poll queues
 * the test drives, call counters, and — for the race tests — gates that hold a native call until
 * the test releases it, so an interleaving can be written down instead of hoped for.
 */
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

export interface PublishProfileCall {
  handle: string;
  cryptidName: string;
  sigil: string;
  color: string;
}

/** The native calls a race test can hold. */
export type HoldableMethod =
  | 'pollPairEvents'
  | 'listPairSessions'
  | 'readProfile'
  | 'start'
  | 'transportDiagnostics'
  | 'nearbyBlePeers';

export class FakeNativeModule {
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
  /** True stands for a binary with a node host, which exports `restartNode`. */
  hostRestart = false;
  restarts: unknown[] = [];

  get restartNode(): ((config?: unknown) => Promise<void>) | undefined {
    if (!this.hostRestart) return undefined;
    return async (config?: unknown) => {
      this.restarts.push(config);
      if (this.bleAvailableAfterRestart) this.caps = { ...this.caps, available: true };
    };
  }

  private handlers: Record<string, (e: unknown) => void> = {};

  private readonly gates = new Map<string, { promise: Promise<void>; release: () => void }>();

  /**
   * Hold every call to `method` made from now on, until released. The call still reads its state
   * when it is MADE — a held `listPairSessions` returns the sessions of the moment it was asked —
   * so a test can tell an old answer from a fresh one.
   *
   * `release` lets the held calls return. `detach` stops holding NEW calls but leaves the ones
   * already held hanging — the shape of a native call that never returns.
   */
  hold(method: HoldableMethod): { release: () => void; detach: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.set(method, { promise, release });
    const detach = () => {
      if (this.gates.get(method)?.promise === promise) this.gates.delete(method);
    };
    return {
      release: () => {
        detach();
        release();
      },
      detach,
    };
  }

  private async gate(method: string): Promise<void> {
    await this.gates.get(method)?.promise;
  }

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
    await this.gate('start');
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
    const profile = this.profiles.get(endpointId) ?? null;
    await this.gate('readProfile');
    return profile;
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
    await this.gate('transportDiagnostics');
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
    await this.gate('pollPairEvents');
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
    const sessions = this.sessions;
    await this.gate('listPairSessions');
    return sessions;
  }
  async pairResult(sessionId: string) {
    this.calls.pairResult.push(sessionId);
    return this.pairResults.get(sessionId) ?? null;
  }
  async nearbyBlePeers() {
    this.calls.nearbyBlePeers += 1;
    await this.gate('nearbyBlePeers');
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
