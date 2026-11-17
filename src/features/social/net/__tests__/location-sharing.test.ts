import type { ContactCard, Friend } from '../../core/types';
import {
  createTelemetry,
  resetEventLogForTesting,
  setTelemetryForTesting,
  type SpanContext,
} from '@/features/dev/telemetry';

/**
 * Wiring tests for the docs-only delivery path in {@link LocationSharingService}, using a fake
 * native module. These prove the plumbing — import a friend's namespace on add, hand every capture
 * to the native gate, mirror the sharing set and the push targets, read the replica when the node
 * announces a change — without a live iroh node. The replication itself is exercised against real
 * nodes in `modules/iroh-location/rust/tests/` and end-to-end per docs/social/ARCHITECTURE.md §9.
 */

type FakeFix = { lat: number; lon: number; accuracyM: number; headingDeg: number; ts: number };

class FakeNativeModule {
  calls = {
    ingestFix: [] as { fix: FakeFix; battery: unknown; intervalMs: number }[],
    heartbeatFix: [] as { intervalMs: number; parked: boolean | null }[],
    publishIntroduction: 0,
    watchReplica: 0,
    unwatchReplica: 0,
    readLatest: 0,
    syncLatest: [] as { peerTickets: string[]; traceparent?: string }[],
    importDocTicket: [] as string[],
    importProfileTicket: [] as string[],
    setSharingRecipients: [] as { recipients: string[]; watchers: string[] }[],
    forgetSession: [] as string[],
    forgetPairSessions: [] as string[],
    forgetDocTicket: [] as string[],
    forgetProfileTicket: [] as string[],
    setDeliveryConfig: [] as {
      peerTickets: string[];
      stashBaseUrl: string | null;
      stashPsk: string | null;
    }[],
  };
  private handlers: Record<string, (e: unknown) => void> = {};

  // ── ratchet state the fake pretends to hold (FORWARD-SECRECY.md §4.5, §4.6) ──────────────
  /** Endpoint ids `isDesynced` should answer `true` for. */
  readonly desynced = new Set<string>();
  /** Endpoint id → how many restarts native has already driven with them. */
  readonly resyncCounts = new Map<string, number>();

  /** Set false to model a binary that still clobbers the node on a second `createNode`. */
  adoptsNode = true;
  /** Set true to model a binary predating the capability probe entirely. */
  omitAdoptionProbe = false;
  adoptionProbes = 0;
  createNodeCalls = 0;

  async nativeRuntimeAdoptsNode(): Promise<boolean> {
    if (this.omitAdoptionProbe) throw new Error('nativeRuntimeAdoptsNode is not a function');
    this.adoptionProbes += 1;
    return this.adoptsNode;
  }

  async createNode() {
    this.createNodeCalls += 1;
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
  async importDocTicket(ticket: string) {
    this.calls.importDocTicket.push(ticket);
    if (this.importFailures.has(ticket)) throw new Error(`import failed: ${ticket}`);
  }
  /** Doc tickets whose import should fail, as a docs engine that cannot open them would. */
  readonly importFailures = new Set<string>();
  async importProfileTicket(ticket: string) {
    this.calls.importProfileTicket.push(ticket);
  }

  // ── the native gate (`publish.rs`), as far as the app can see it ─────────────────────────
  /** What the next `ingestFix` reports. `published > 0` also writes our slot, as native does. */
  ingestOutcome = {
    accepted: true,
    rejection: null as string | null,
    enqueued: 1,
    published: 1,
    pending: 0,
    slotsSkipped: 0,
    overflowDropped: 0,
    suspended: false,
  };
  seq = 0;
  async ingestFix(fix: FakeFix, battery: unknown, intervalMs: number) {
    this.calls.ingestFix.push({ fix, battery, intervalMs });
    if (this.ingestOutcome.published > 0) {
      this.seq += 1;
      this.trailFixes.push({ author: 'aa11', seq: this.seq, fix });
    }
    return { ...this.ingestOutcome };
  }
  async heartbeatFix(_battery: unknown, intervalMs: number, parked: boolean | null) {
    this.calls.heartbeatFix.push({ intervalMs, parked });
    return { ...this.ingestOutcome, enqueued: 0, published: 0 };
  }
  async publishIntroduction() {
    this.calls.publishIntroduction += 1;
    this.seq += 1;
    return { ...this.ingestOutcome, published: 1 };
  }
  async currentSeq() {
    return this.seq;
  }
  watchReplica() {
    this.calls.watchReplica += 1;
  }
  unwatchReplica() {
    this.calls.unwatchReplica += 1;
  }
  async setSharingRecipients(recipients: string[], watchers: string[]) {
    this.calls.setSharingRecipients.push({ recipients, watchers });
  }

  async isDesynced(peerEndpointHex: string) {
    return this.desynced.has(peerEndpointHex);
  }
  async resyncCount(peerEndpointHex: string) {
    return this.resyncCounts.get(peerEndpointHex) ?? 0;
  }
  async forgetSession(peerEndpointHex: string) {
    this.calls.forgetSession.push(peerEndpointHex);
  }
  /** How many finished pairing sessions the fake native side claims to have dropped. */
  forgetPairSessionsResult = 1;
  async forgetPairSessions(peerEndpointHex: string) {
    this.calls.forgetPairSessions.push(peerEndpointHex);
    return this.forgetPairSessionsResult;
  }
  async forgetDocTicket(ticket: string) {
    this.calls.forgetDocTicket.push(ticket);
    return true;
  }
  async forgetProfileTicket(ticket: string) {
    this.calls.forgetProfileTicket.push(ticket);
    return true;
  }
  async syncLatest(peerTickets: string[], traceparent?: string | null) {
    this.calls.syncLatest.push({
      peerTickets,
      ...(traceparent ? { traceparent } : {}),
    });
  }
  async setDeliveryConfig(
    peerTickets: string[],
    stashBaseUrl: string | null,
    stashPsk: string | null
  ) {
    this.calls.setDeliveryConfig.push({ peerTickets, stashBaseUrl, stashPsk });
  }
  trailFixes: { author: string; seq: number; fix: FakeFix }[] = [];
  trailNulls: { author: string; seq: number; ts: number; kind: 'null'; fix?: undefined }[] = [];
  async readLatest() {
    this.calls.readLatest += 1;
    // One overwritten slot per author: a read yields each author's current fix, nothing behind it.
    const current = new Map<string, (typeof this.trailFixes)[number]>();
    for (const f of this.trailFixes) {
      const held = current.get(f.author);
      if (!held || f.fix.ts > held.fix.ts || (f.fix.ts === held.fix.ts && f.seq > held.seq)) {
        current.set(f.author, f);
      }
    }
    return [
      ...[...current.values()].map((incoming) => ({
        ...incoming,
        ts: incoming.fix.ts,
        kind: 'fix' as const,
      })),
      ...this.trailNulls,
    ];
  }
  async pruneTrail() {}

  /** What the native drain has published and not yet handed over — see `own_log.rs`. */
  ownPublished: { seq: number; fix: FakeFix }[] = [];
  async takeOwnPublished() {
    return this.ownPublished.splice(0);
  }
  /** Who the last natively-sealed envelope left out, as `<endpoint>:<reason>`. */
  sealDroppedPeers: string[] | null = null;
  async lastSealReport() {
    if (this.sealDroppedPeers === null) return null;
    return {
      at: 1,
      recipients: 1,
      dropped: this.sealDroppedPeers.length,
      lapsed: 0,
      noSession: 0,
      other: 0,
      droppedPeers: this.sealDroppedPeers,
    };
  }
  addListener(name: string, cb: (e: unknown) => void) {
    this.handlers[name] = cb;
    return {
      remove: () => {
        delete this.handlers[name];
      },
    };
  }
  emit(name: string, event: unknown) {
    this.handlers[name]?.(event);
  }
}

const mockHolder: {
  mod: FakeNativeModule;
  stashConfig: { baseUrl: string; ticket: string; psk: null } | null;
} = { mod: new FakeNativeModule(), stashConfig: null };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => mockHolder.stashConfig,
}));

// Keep persistence + key storage side-effect-free in the test (fall back to in-memory).
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

// ...and that has to include SQLite, or the fallback above never actually happens: `persistence.ts`
// opens a REAL database when expo-sqlite resolves, so these tests were sharing one on-disk DB and
// carrying `sc.social.*` state between runs. Failing the open is the supported route to the
// in-memory stores — see `getDb`.
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('SQLite is deliberately unavailable in this suite');
  },
}));

// The watcher lifecycle installs an AppState listener in `init`. Spy on the real one to capture it:
// spreading `requireActual('react-native')` eagerly evaluates every getter in the RN index (DevMenu,
// FlatList, ...) and blows up under jest-expo, so a module mock is not an option here.

/** Drive an AppState transition through every listener the service installed. */

// eslint-disable-next-line import/first
import {
  LocationSharingService,
  TRAIL_CHANGE_COALESCE_MS,
  type SharingSnapshot,
} from '../location-sharing';

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

const friend: ContactCard = {
  endpointId: 'bb22',
  handle: '@bee',
  sigil: 'jackalope',
  recvPublic: 'b0b0',
  ticket: 'ticket-b',
  docTicket: 'doc-b',
};

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('LocationSharingService — durable trail wiring', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    // The durable journal is what the shipper drains, so spans carry between tests unless it is
    // cleared here too — the telemetry singleton is no longer the whole of the exported state.
    resetEventLogForTesting();
  });

  it('imports a friend docs namespace (their docTicket) when added', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    const paired: Friend = { ...friend, profileTicket: 'profile-b' };
    await svc.addFriend(paired);
    expect(mockHolder.mod.calls.importDocTicket).toEqual(['doc-b']);
    expect(mockHolder.mod.calls.importProfileTicket).toEqual(['profile-b']);
  });

  it('removes a friend, revokes sharing, and never resurrects their dot', async () => {
    const svc = makeService();
    const snapshots: SharingSnapshot[] = [];
    svc.onChange((snapshot) => snapshots.push(snapshot));
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    mockHolder.mod.trailFixes.push({
      author: friend.endpointId,
      seq: 1,
      fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 },
    });
    await svc.syncTrail(0);
    expect((await svc.friendLatest()).some((p) => p.author === friend.endpointId)).toBe(true);

    await svc.removeFriend(friend.endpointId);

    const latest = snapshots.at(-1);
    expect(latest?.friends).toEqual([]);
    expect(latest?.sharingWith).toEqual([]);
    expect(mockHolder.mod.calls.forgetDocTicket).toEqual(['doc-b']);
    expect(mockHolder.mod.calls.setSharingRecipients.at(-1)).toEqual({
      recipients: [],
      watchers: [],
    });
    expect((await svc.friendLatest()).some((p) => p.author === friend.endpointId)).toBe(false);

    // Their slot is still in our replica until the namespace is dropped, and a newer one can land
    // in the meantime. Reading it must not bring them back.
    mockHolder.mod.trailFixes.push({
      author: friend.endpointId,
      seq: 2,
      fix: { lat: 3, lon: 4, accuracyM: 3, headingDeg: 0, ts: 200 },
    });
    await svc.syncTrail(0);
    expect((await svc.friendLatest()).some((p) => p.author === friend.endpointId)).toBe(false);
  });

  it('imports a friend again when they are re-added after removal', async () => {
    // `connectedFriends` is what keeps a friend from being imported twice. A removal that left
    // them in it would make the re-add a silent no-op, and their trail would never reopen.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    await svc.removeFriend(friend.endpointId);
    await svc.addFriend(friend);

    expect(mockHolder.mod.calls.importDocTicket).toEqual(['doc-b', 'doc-b']);
  });

  it('retries a friend whose trail import failed instead of marking them connected', async () => {
    // The namespace import is the only way their position can reach us. A failure is surfaced, and
    // the friend stays unconnected so the next pass imports again rather than skipping them.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.importFailures.add('doc-b');

    await expect(svc.addFriend(friend)).rejects.toThrow('import failed: doc-b');

    mockHolder.mod.importFailures.clear();
    await (svc as unknown as { connectFriend(f: ContactCard): Promise<void> }).connectFriend(
      friend
    );
    await (svc as unknown as { connectFriend(f: ContactCard): Promise<void> }).connectFriend(
      friend
    );
    expect(mockHolder.mod.calls.importDocTicket).toEqual(['doc-b', 'doc-b']);
  });

  it('publishes the configured cryptid metadata in its contact card', async () => {
    const svc = makeService();
    await svc.init('@me', '  /\\\n (oo)', 'Tunnel Oracle', '#337FBE');
    expect(svc.selfCard()).toMatchObject({
      handle: '@me',
      sigil: '  /\\\n (oo)',
      cryptidName: 'Tunnel Oracle',
      color: '#337FBE',
    });
  });

  it('forces a supplied fix through the native gate, not a side door', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    const fix = { lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 };

    await expect(svc.forceLocationPush(fix, 'scheduled')).resolves.toBe(1);

    expect(mockHolder.mod.calls.ingestFix).toHaveLength(1);
    expect(mockHolder.mod.calls.ingestFix[0].fix).toMatchObject(fix);
    // The slot was due, so the gate published it; nothing off the grid was needed.
    expect(mockHolder.mod.calls.publishIntroduction).toBe(0);
  });

  it('sends a forced fix off the grid when its slot is already covered', async () => {
    // Accepted but not published: the gate took the position into a slot that already went out.
    // A developer pressing Push wants to watch a ping travel, so it goes out as an introduction.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.ingestOutcome = { ...mockHolder.mod.ingestOutcome, published: 0 };

    await svc.forceLocationPush({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.publishIntroduction).toBe(1);
  });

  it('reports a fix the gate refused rather than pretending it went out', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.ingestOutcome = {
      ...mockHolder.mod.ingestOutcome,
      accepted: false,
      rejection: 'low_accuracy',
      published: 0,
    };

    await expect(
      svc.forceLocationPush({ lat: 1, lon: 2, accuracyM: 900, headingDeg: 0, ts: 123 })
    ).rejects.toThrow('low_accuracy');
    expect(mockHolder.mod.calls.publishIntroduction).toBe(0);
  });

  it('passes the sync trace context across the native boundary', async () => {
    const parent: SpanContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    setTelemetryForTesting(
      createTelemetry({
        endpoint: 'http://collector.test',
        transport: async () => {},
      })
    );
    const svc = makeService();
    await svc.init('@me', 'mothman');

    await svc.syncTrail(0, parent);

    expect(mockHolder.mod.calls.syncLatest.at(-1)?.traceparent).toMatch(
      new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`)
    );
  });

  it('syncTrail triggers native range reconciliation', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.syncTrail(0);
    expect(mockHolder.mod.calls.syncLatest).toEqual([{ peerTickets: [] }]);
  });

  it('coalesces overlapping trail syncs into one native pass', async () => {
    // Regression, 2026-09-10. `syncTrail` is fired by a node restart, a foreground resume, a
    // completed pair and the init effect, and none of them knew about the others. Measured on one
    // phone: five passes in flight at once, each over 100s, all reconciling the same replicas —
    // and between them they saturated the docs engine that the pairing poll's profile reads have
    // to queue behind, which is what made the SAS screen open a minute late.
    //
    // `syncLatest` is a global, idempotent pass over every namespace, so a second caller wants
    // exactly the work already underway. It joins instead of starting a rival.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    mockHolder.mod.calls.syncLatest.length = 0;

    let release = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = mockHolder.mod.syncLatest.bind(mockHolder.mod);
    mockHolder.mod.syncLatest = async (peerTickets: string[], traceparent?: string | null) => {
      await record(peerTickets, traceparent);
      await inFlight;
    };

    const first = svc.syncTrail(0);
    const second = svc.syncTrail(0);
    release();
    await Promise.all([first, second]);

    expect(mockHolder.mod.calls.syncLatest).toHaveLength(1);

    // The join is per-pass, not a latch: once it settles the next caller starts a fresh one.
    mockHolder.mod.syncLatest = record;
    await svc.syncTrail(0);
    expect(mockHolder.mod.calls.syncLatest).toHaveLength(2);
  });

  it('moves our own dot from the replica, not only from a manual push', async () => {
    // Regression, 2026-08-30: "I cannot hit the location button (greyed out) after restarting the
    // app. It seems to only work when a push has happened."
    //
    // The locate-me control is gated on `!hasLiveSelfFix || !selfFix`, and `hasLiveSelfFix` comes
    // from `onLocalFix`. When capture moved into Rust, `ingestAndTrackLocal` — the only thing that
    // fed our own dot from the pipeline — was left uncalled and nothing replaced it, so the sole
    // live writer of `latestLocalFix` was the debug Push button. The user's description was an
    // exact statement of the bug.
    //
    // The native runtime publishes with no JS alive, so the replica is where our own position has
    // to come from now.
    const svc = makeService();
    await svc.init('@me', 'mothman');

    const seen: { lat: number; lon: number; ts: number }[] = [];
    svc.onLocalFix((fix) => seen.push(fix));
    expect(seen).toHaveLength(0);

    mockHolder.mod.trailFixes.push({
      author: 'aa11',
      seq: 9,
      fix: { lat: 47.6062, lon: -122.3321, accuracyM: 12, headingDeg: 0, ts: 5_000 },
    });
    await svc.syncTrail(0);

    expect(seen.at(-1)).toMatchObject({ lat: 47.6062, lon: -122.3321, ts: 5_000 });
  });

  it('never walks our own dot backwards from a replayed replica entry', async () => {
    // `readLatest` is re-read in full on every sync, so the same entry arrives repeatedly and an
    // older one can arrive after a newer publish. The dot must not jump back to it.
    const svc = makeService();
    await svc.init('@me', 'mothman');

    const seen: { ts: number }[] = [];
    svc.onLocalFix((fix) => seen.push(fix));

    mockHolder.mod.trailFixes.push({
      author: 'aa11',
      seq: 9,
      fix: { lat: 47.6062, lon: -122.3321, accuracyM: 12, headingDeg: 0, ts: 5_000 },
    });
    await svc.syncTrail(0);

    await svc.forceLocationPush(
      { lat: 47.61, lon: -122.33, accuracyM: 8, headingDeg: 0, ts: 9_000 },
      'manual'
    );
    await svc.syncTrail(0);

    expect(seen.at(-1)?.ts).toBe(9_000);
  });

  it('syncTrail explicitly targets the configured stash when opted in', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = { configured: true, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('stash');

    await svc.syncTrail(123);

    expect(mockHolder.mod.calls.syncLatest).toContainEqual({
      peerTickets: ['ticket-stash'],
    });
  });

  it('syncTrail reads the durable replica into the trail (silent reconciliation)', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    // Reconciliation landed a friend fix in the replica without firing a live/backfill event.
    mockHolder.mod.trailFixes = [
      { author: 'bb22', seq: 7, fix: { lat: 5, lon: 6, accuracyM: 4, headingDeg: 0, ts: 555 } },
    ];
    let recovered: number | null = null;
    svc.onChange((s) => {
      recovered = s.lastSyncRecovered;
    });

    await svc.syncTrail(0);

    expect(recovered).toBe(1);
    const latest = await svc.friendLatest();
    expect(latest.some((p) => p.author === 'bb22' && p.seq === 7)).toBe(true);
  });

  it('reads a native background pull out of the replica without dialling anyone', async () => {
    // The native runtime pulled while the app was off screen and the entries are already in the
    // replica. The app's half is a local read, so the map is current the moment it is opened —
    // a second network pass here would cost exactly the background time the pull was bounded by.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    const syncsBefore = mockHolder.mod.calls.syncLatest.length;
    mockHolder.mod.trailFixes = [
      { author: 'bb22', seq: 11, fix: { lat: 7, lon: 8, accuracyM: 4, headingDeg: 0, ts: 777 } },
    ];
    // The snapshot, not the trail-change fan-out: that one is coalesced behind a timer.
    let notified = 0;
    svc.onChange(() => {
      notified += 1;
    });
    notified = 0;

    await (
      svc as unknown as {
        handleNativePull(e: { trigger: string; entries: number; elapsedMs: number }): Promise<void>;
      }
    ).handleNativePull({ trigger: 'periodic', entries: 1, elapsedMs: 900 });

    const latest = await svc.friendLatest();
    expect(latest.some((p) => p.author === 'bb22' && p.seq === 11)).toBe(true);
    expect(notified).toBeGreaterThan(0);
    expect(mockHolder.mod.calls.syncLatest.length).toBe(syncsBefore);
  });

  it('reads a friend fix into the trail when the node announces a replica change', async () => {
    // The live path now: iroh-docs replicates the friend's slot, the node announces which authors
    // changed, and the app reads the replica. No dial, and no second copy of the fix on any event.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    expect(mockHolder.mod.calls.watchReplica).toBe(1);
    let repaints = 0;
    svc.onTrailChange(() => {
      repaints += 1;
    });
    const syncsBefore = mockHolder.mod.calls.syncLatest.length;

    mockHolder.mod.trailFixes.push({
      author: friend.endpointId,
      seq: 5,
      fix: { lat: 10, lon: 20, accuracyM: 3, headingDeg: 0, ts: 999 },
    });
    mockHolder.mod.emit('onReplicaChanged', { authors: [friend.endpointId] });
    mockHolder.mod.emit('onReplicaChanged', { authors: [friend.endpointId] });
    await new Promise((r) => setTimeout(r, TRAIL_CHANGE_COALESCE_MS + 50));
    await flush();

    const latest = await svc.friendLatest();
    expect(latest.some((p) => p.author === friend.endpointId && p.seq === 5)).toBe(true);
    // The repaint fan-out has its own coalescing window after the read.
    await new Promise((r) => setTimeout(r, TRAIL_CHANGE_COALESCE_MS + 50));
    expect(repaints).toBe(1);
    expect(mockHolder.mod.calls.syncLatest.length).toBe(syncsBefore);
  });

  it('coalesces a burst of replica announcements into one read', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    const readsBefore = mockHolder.mod.calls.readLatest;

    for (let i = 0; i < 5; i += 1) {
      mockHolder.mod.emit('onReplicaChanged', { authors: [friend.endpointId] });
    }
    await new Promise((r) => setTimeout(r, TRAIL_CHANGE_COALESCE_MS + 50));
    await flush();

    expect(mockHolder.mod.calls.readLatest - readsBefore).toBe(1);
  });

  it('ignores a replica change that names nobody it pools with', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    const readsBefore = mockHolder.mod.calls.readLatest;

    mockHolder.mod.emit('onReplicaChanged', { authors: ['ffff'] });
    await new Promise((r) => setTimeout(r, TRAIL_CHANGE_COALESCE_MS + 50));
    await flush();

    expect(mockHolder.mod.calls.readLatest).toBe(readsBefore);
  });

  it('stops watching the replica at shutdown', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');

    await svc.shutdownAsync();

    expect(mockHolder.mod.calls.unwatchReplica).toBe(1);
  });

  it('starts on a binary that cannot announce replica changes', async () => {
    // A phone can run an older binary than the bundle. With no announcements the presence pull
    // clock still reads the replica, so this is slower, not broken.
    (mockHolder.mod as { watchReplica?: unknown }).watchReplica = undefined;
    (mockHolder.mod as { unwatchReplica?: unknown }).unwatchReplica = undefined;
    const svc = makeService();

    await expect(svc.init('@me', 'mothman')).resolves.not.toThrow();
    await expect(svc.shutdownAsync()).resolves.not.toThrow();
  });

  it('keeps only the newest fix per friend in the trail cache', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.trailFixes.push({
      author: 'bb22',
      seq: 51,
      fix: { lat: 10, lon: 20, accuracyM: 3, headingDeg: 0, ts: 1001 },
    });
    await svc.syncTrail(0);
    mockHolder.mod.trailFixes.push({
      author: 'bb22',
      seq: 52,
      fix: { lat: 11, lon: 21, accuracyM: 3, headingDeg: 0, ts: 1002 },
    });
    await svc.syncTrail(0);

    // A friend collapses to their newest fix — their history is not retained.
    const full = await svc.friendLatest();
    expect(full.filter((point) => point.author === 'bb22').map((point) => point.seq)).toEqual([52]);
  });

  it('surfaces the recovered count from a sync into the snapshot', async () => {
    // The count is now derived app-side from what the replica read actually stored, rather than
    // from a native `onSync` callback: with one overwritten slot per author there is no backfill
    // stream to report progress on, so the sink that used to emit it is gone.
    const svc = makeService();
    let recovered: number | null = null;
    svc.onChange((s) => {
      recovered = s.lastSyncRecovered;
    });
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.trailFixes = [
      { author: 'bb22', seq: 1, fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 900 } },
    ];
    await svc.syncTrail(0);
    expect(recovered).toBe(1);

    // Nothing new in the replica: the watermark skips the re-store, so nothing is "recovered".
    await svc.syncTrail(0);
    expect(recovered).toBe(0);
  });

  it('surfaces fix and null ratchet responses per friend from the replica', async () => {
    const svc = makeService();
    let activity: SharingSnapshot['ratchetActivity'] = {};
    svc.onChange((snapshot) => {
      activity = snapshot.ratchetActivity;
    });
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    mockHolder.mod.trailFixes = [
      {
        author: friend.endpointId,
        seq: 21,
        fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 900 },
      },
    ];
    mockHolder.mod.trailNulls = [{ author: friend.endpointId, seq: 22, ts: 1_000, kind: 'null' }];

    await svc.syncTrail(0);

    expect(activity[friend.endpointId]).toMatchObject({
      fix: { seq: 21 },
      null: { seq: 22 },
    });
  });
});

describe('LocationSharingService — native delivery targets', () => {
  // Publishing is not delivery. A publish writes the LOCAL replica, and iroh-docs' live engine only
  // reaches peers already in our namespace's swarm — nobody, on a background wake — so a native
  // drain that does not know who to push to seals correctly, reports success, and delivers
  // nothing. Two phones ran a full day in that state on 2026-08-31.
  // These assert the app tells native where to send, at every point the answer can change.
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    resetEventLogForTesting();
  });

  it('seeds the native push targets on init, before anything has changed', async () => {
    // A device whose pool has not changed since the last launch would otherwise leave native
    // holding a list nobody refreshed, and a background wake would publish to nowhere.
    const svc = makeService();
    await svc.init('@me', 'mothman');

    expect(mockHolder.mod.calls.setDeliveryConfig.length).toBeGreaterThan(0);
  });

  it('mirrors a friend ticket to native when the pool changes', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    expect(mockHolder.mod.calls.setDeliveryConfig.at(-1)?.peerTickets).toContain('ticket-b');
  });

  it('sends the stash URL only once it is opted into, and the ticket leads', async () => {
    // Gated on the opt-in rather than on the stash being built into this bundle: uploading for a
    // user who switched it off would PUT sealed envelopes into a namespace nothing registered.
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = { configured: true, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');

    expect(mockHolder.mod.calls.setDeliveryConfig.at(-1)?.stashBaseUrl).toBeNull();

    await svc.setDeliveryMode('stash');

    const latest = mockHolder.mod.calls.setDeliveryConfig.at(-1);
    expect(latest?.stashBaseUrl).toBe('https://stash.example.com');
    // Same order as `durablePeerTickets`: the stash is always-on and usually answers immediately.
    expect(latest?.peerTickets[0]).toBe('ticket-stash');
  });

  /**
   * The stash forgets every namespace when it restarts, and JS re-registered them only on a
   * foreground launch, so a phone the native runtime drove stayed unregistered. A binary with the
   * native grant does it on every node start; JS hands over instead of repeating it over HTTP.
   */
  it('hands the stash grant to native when the binary has it', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const registered: string[] = [];
    const stash = {
      configured: true,
      registerNamespace: async ({ readTicket }: { readTicket: string }) => {
        registered.push(readTicket);
      },
    };
    let grants = 0;
    (mockHolder.mod as { grantStash?: () => Promise<void> }).grantStash = async () => {
      grants += 1;
    };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('stash');
    await svc.addFriend(friend);

    expect(grants).toBeGreaterThan(0);
    expect(registered).toEqual([]);
  });

  it('still grants over HTTP on a binary without the native grant', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const registered: string[] = [];
    const stash = {
      configured: true,
      registerNamespace: async ({ readTicket }: { readTicket: string }) => {
        registered.push(readTicket);
      },
    };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('stash');
    await svc.addFriend(friend);

    expect(registered).toContain('doc-self');
    expect(registered).toContain('doc-b');
  });

  it('stops naming the stash when the user switches back to peer-only relay', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = { configured: true, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('stash');
    await svc.setDeliveryMode('mutual');

    const latest = mockHolder.mod.calls.setDeliveryConfig.at(-1);
    expect(latest?.stashBaseUrl).toBeNull();
    expect(latest?.peerTickets).not.toContain('ticket-stash');
  });

  it('does not upload to the stash when the route chosen is peer-only relay', async () => {
    // `mutual` keeps pushing to every pool member and stops at the server. A three-way choice
    // must not collapse into "stash or not", or picking it would quietly keep using the stash.
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = { configured: true, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('mutual');

    const latest = mockHolder.mod.calls.setDeliveryConfig.at(-1);
    expect(latest?.stashBaseUrl).toBeNull();
    expect(latest?.peerTickets).not.toContain('ticket-stash');
  });

  it('reports the stash as chosen-but-unavailable rather than silently using it', async () => {
    // No stash deployed for this build. The preference is kept as given — the same install can
    // gain a stash on the next build — but the effective route is direct, and the screen has to
    // be able to tell the difference in order to say so.
    mockHolder.stashConfig = null;
    const stash = { configured: false, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    // `snapshot()` is private to the service; observe the emissions instead.
    const snapshots: SharingSnapshot[] = [];
    svc.onChange((snapshot) => snapshots.push(snapshot));
    await svc.init('@me', 'mothman');
    await svc.setDeliveryMode('stash');

    const delivery = snapshots.at(-1)!.delivery;
    expect(delivery.mode).toBe('stash');
    expect(delivery.effectiveMode).toBe('mutual');
    expect(delivery.stashConfigured).toBe(false);
    expect(mockHolder.mod.calls.setDeliveryConfig.at(-1)?.stashBaseUrl).toBeNull();
  });

  it('tolerates a binary built before the native push path existed', async () => {
    // A phone can run an older binary than the JS bundle; the guard must report the truth rather
    // than throwing inside a pool change.
    const mod = new FakeNativeModule();
    (mod as { setDeliveryConfig?: unknown }).setDeliveryConfig = undefined;
    mockHolder.mod = mod;
    const svc = makeService();

    await expect(svc.init('@me', 'mothman')).resolves.not.toThrow();
    await expect(svc.addFriend(friend)).resolves.not.toThrow();
  });
});

describe('LocationSharingService — the sharing set native seals for', () => {
  const watcherFriend: ContactCard = {
    endpointId: 'cc33',
    handle: '@cee',
    sigil: 'chupacabra',
    recvPublic: 'c0c0',
    ticket: 'ticket-c',
    docTicket: 'doc-c',
  };

  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    resetEventLogForTesting();
  });

  // Native seals a fix for the recipients and a null for the watchers on every tick
  // (FORWARD-SECRECY.md §4.7). The app's whole part is to say which friend is which.
  it('names sharing recipients and watch-only friends separately, and never both', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.addFriend(watcherFriend);
    await svc.shareWith(friend.endpointId);

    const latest = mockHolder.mod.calls.setSharingRecipients.at(-1);
    expect(latest).toEqual({
      recipients: [friend.endpointId],
      watchers: [watcherFriend.endpointId],
    });
  });

  it('moves a friend back to the watcher set when sharing is revoked', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);

    await svc.revoke(friend.endpointId);

    expect(mockHolder.mod.calls.setSharingRecipients.at(-1)).toEqual({
      recipients: [],
      watchers: [friend.endpointId],
    });
  });

  it('seals the introduction only after the new sharing set has reached native', async () => {
    // Native seals for the set IT holds, so an introduction that overtook the mirror would go out
    // sealed for yesterday's set and the new friend could not open it.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHolder.mod.setSharingRecipients = async (recipients: string[], watchers: string[]) => {
      await held;
      order.push(`recipients:${recipients.join(',')}|${watchers.join(',')}`);
    };
    mockHolder.mod.publishIntroduction = async () => {
      order.push('introduction');
      return { ...mockHolder.mod.ingestOutcome, published: 1 };
    };

    await svc.revoke(friend.endpointId);
    await svc.shareWith(friend.endpointId);
    const intro = (
      svc as unknown as { publishIntroduction(): Promise<void> }
    ).publishIntroduction();
    release();
    await intro;

    expect(order.at(-1)).toBe('introduction');
    expect(order).toContain(`recipients:${friend.endpointId}|`);
  });
});

/**
 * Forward-secrecy health surfacing — FORWARD-SECRECY.md §4.5, §4.6 / §7 step 7.
 *
 * Sealing and recovery are native (`publish.rs`, `restart.rs`); a short wrap list is not a
 * partial success, so the app has to read what native reports and say which of the lookalike
 * reasons a friend stopped receiving fixes. These pin that reading.
 */
describe('LocationSharingService — session health', () => {
  const watcher: ContactCard = {
    endpointId: 'cc33',
    handle: '@cee',
    sigil: 'chupacabra',
    recvPublic: 'c0c0',
    ticket: 'ticket-c',
    docTicket: 'doc-c',
  };

  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    // The durable journal is what the shipper drains, so spans carry between tests unless it is
    // cleared here too — the telemetry singleton is no longer the whole of the exported state.
    resetEventLogForTesting();
  });

  async function shared(): Promise<LocationSharingService> {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    return svc;
  }

  /**
   * A getter for the latest session-health map the service has emitted, read through its public
   * change stream. A getter rather than a value because each emit hands over a *new* object — a
   * captured reference would pin the empty one from before the read.
   */
  function healthOf(svc: LocationSharingService): () => Record<string, string> {
    let latest: Record<string, string> = {};
    svc.onChange((s) => {
      latest = s.sessions.byFriend;
    });
    return () => latest;
  }

  it('surfaces a friend with no ratchet session as needing a re-pair', async () => {
    // The one drop reason no amount of waiting fixes: sessions are rooted only by the SAS bump,
    // so a friend paired before envelope v3 needs the two humans in a room again.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.sealDroppedPeers = [`${friend.endpointId}:no_session`];

    await svc.syncTrail(0);

    expect(health()[friend.endpointId]).toBe('needs-repair');
  });

  it('distinguishes a lapsed friend from one that needs a re-pair', async () => {
    // §4.5 asks for these to read differently to a human: lapsed means "their app has not run for
    // a day" and resolves itself the moment it does, which is not a re-pair.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.sealDroppedPeers = [`${friend.endpointId}:lapsed`];

    await svc.syncTrail(0);

    expect(health()[friend.endpointId]).toBe('lapsed');
  });

  it('does not surface a transient responder-window drop to the user', async () => {
    // `no_sending_chain` is a responder waiting for the initiator's first envelope. It clears
    // itself on the next tick, so putting it in front of a human would be noise.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.sealDroppedPeers = [`${friend.endpointId}:no_sending_chain`];

    await svc.syncTrail(0);

    expect(health()).toEqual({});
  });

  it('clears a drop once the friend is reachable again', async () => {
    // Rebuilt from each seal report rather than accumulated, so recovery needs no clearing path.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.sealDroppedPeers = [`${friend.endpointId}:no_session`];
    await svc.syncTrail(0);
    expect(health()[friend.endpointId]).toBe('needs-repair');

    mockHolder.mod.sealDroppedPeers = [];
    await svc.syncTrail(0);

    expect(health()).toEqual({});
  });

  it('leaves a friend marked desynced while native recovery is still in flight', async () => {
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.desynced.add(friend.endpointId);

    await svc.syncTrail(0);

    expect(health()[friend.endpointId]).toBe('desynced');
  });

  it('asks for a re-pair once native recovery keeps failing', async () => {
    // "A resync loop surfaces a 're-pair with this friend' prompt rather than retrying forever."
    // A session restarted three times that still does not work will not be fixed by a fourth.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.desynced.add(friend.endpointId);
    mockHolder.mod.resyncCounts.set(friend.endpointId, 3);

    await svc.syncTrail(0);

    expect(health()[friend.endpointId]).toBe('recovery-failed');
  });

  it('checks watch-only friends too, not just the ones we share with', async () => {
    // A watcher edge is a session like any other — it is how our own fixes stay openable by them
    // — so its health must be read too, or half the pool could break unseen.
    const svc = makeService();
    const health = healthOf(svc);
    await svc.init('@me', 'mothman');
    await svc.addFriend(watcher);
    mockHolder.mod.desynced.add(watcher.endpointId);

    await svc.syncTrail(0);

    expect(health()[watcher.endpointId]).toBe('desynced');
  });

  it('forgets the ratchet session when a friend is removed', async () => {
    // §5.4: chain keys for a relationship that no longer exists are material whose only remaining
    // use is to a seized device.
    const svc = await shared();

    await svc.removeFriend(friend.endpointId);

    expect(mockHolder.mod.calls.forgetSession).toEqual([friend.endpointId]);
  });

  /**
   * The pairing session is the same §5.4 argument one record over — it holds their recv key, SAS
   * material and tickets — and AGENTS.md already said a completed pair is torn down by
   * `removeFriend`. Only the ratchet half was implemented, so a Pixel was still holding
   * `sessions=1 states=[complete]` half an hour after the unfriend.
   */
  it('forgets the pairing sessions when a friend is removed', async () => {
    const svc = await shared();

    await svc.removeFriend(friend.endpointId);

    expect(mockHolder.mod.calls.forgetPairSessions).toEqual([friend.endpointId]);
  });

  /**
   * The node reopens every namespace it ever imported on each start (`ns_book.rs`), so a removal
   * has to tell it — or a removed friend's trail is reconciled, and granted to the stash, forever.
   */
  it("forgets a removed friend's trail namespace", async () => {
    const svc = await shared();

    await svc.removeFriend(friend.endpointId);

    expect(mockHolder.mod.calls.forgetDocTicket).toEqual(['doc-b']);
  });

  it('removes a friend fine on a binary that predates the namespace book', async () => {
    const svc = await shared();
    (mockHolder.mod as { forgetDocTicket?: unknown }).forgetDocTicket = undefined;
    (mockHolder.mod as { forgetProfileTicket?: unknown }).forgetProfileTicket = undefined;

    await expect(svc.removeFriend(friend.endpointId)).resolves.toBeUndefined();

    expect(mockHolder.mod.calls.forgetSession).toEqual([friend.endpointId]);
  });

  /** A phone can be running an older binary than this bundle; the export may simply be absent. */
  it('removes a friend fine on a binary with no pairing-session forget', async () => {
    const svc = await shared();
    (mockHolder.mod as { forgetPairSessions?: unknown }).forgetPairSessions = undefined;

    await expect(svc.removeFriend(friend.endpointId)).resolves.toBeUndefined();

    expect(mockHolder.mod.calls.forgetSession).toEqual([friend.endpointId]);
    expect(mockHolder.mod.calls.forgetPairSessions).toEqual([]);
  });
});

describe('LocationSharingService — the read path does not need the node', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    resetEventLogForTesting();
  });

  it('hydrates friends from storage without creating a node', async () => {
    // The decoupling in one assertion: everything the map draws is on disk, so it must be
    // reachable before `init()` builds a node, starts it, and answers two permission prompts.
    const svc = makeService();
    await svc.hydrateFromStore();
    expect(mockHolder.mod.createNodeCalls).toBe(0);
  });

  it('is idempotent, so repeated mounts cost one read', async () => {
    const svc = makeService();
    await svc.hydrateFromStore();
    await svc.hydrateFromStore();
    expect(mockHolder.mod.createNodeCalls).toBe(0);
  });

  it('never clobbers a pool that init() already populated', async () => {
    // `init()` is the source of truth; hydration only fills the gap before it. Running late must
    // not roll a live pool back to whatever was last persisted.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    const snapshots: SharingSnapshot[] = [];
    const unsubscribe = svc.onChange((snapshot) => snapshots.push(snapshot));
    const before = snapshots.at(-1)!.friends.map((f) => f.endpointId);
    expect(before).toEqual([friend.endpointId]);
    await svc.hydrateFromStore();
    unsubscribe();
    const unsubscribeAfterHydration = svc.onChange((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)!.friends.map((f) => f.endpointId)).toEqual(before);
    unsubscribeAfterHydration();
  });
});

describe('LocationSharingService — ready does not wait on post-ready work', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    resetEventLogForTesting();
  });

  it('reaches ready while the first pairing poll never returns, and names each step', async () => {
    // 2026-10-13: a Pixel 10's init sat in the old `pairing` phase for 11+ minutes, so the map
    // never left the positions it had loaded from disk. Those calls now run after `ready`.
    const pollable = mockHolder.mod as unknown as Record<string, unknown>;
    pollable.pollPairEvents = async () => [];
    pollable.pollProfileEvents = async () => [];
    pollable.listPairSessions = () => new Promise(() => {});
    pollable.nearbyBlePeers = async () => [];
    pollable.bleCapabilities = async () => ({ pairingReady: false });
    const sent: {
      resourceSpans?: {
        scopeSpans?: {
          spans?: { name: string; attributes: { key: string; value: unknown }[] }[];
        }[];
      }[];
    }[] = [];
    const telemetry = createTelemetry({
      endpoint: 'http://collector.test',
      transport: async (_url, body) => {
        sent.push(JSON.parse(body) as (typeof sent)[number]);
      },
    });
    setTelemetryForTesting(telemetry);

    const svc = makeService();
    const statuses: string[] = [];
    const unsubscribe = svc.onChange((snapshot) => statuses.push(snapshot.status));
    await svc.init('@me', 'mothman');
    unsubscribe();
    expect(statuses.at(-1)).toBe('ready');

    await flush();
    await telemetry.flush();
    const steps = sent
      .flatMap((payload) => payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [])
      .filter((span) => span.name === 'app.init.step')
      .map((span) => {
        const attr = (key: string) => span.attributes.find((a) => a.key === key)?.value;
        return [attr('init.step'), attr('outcome')];
      });
    expect(steps).toEqual(
      expect.arrayContaining([
        [{ stringValue: 'profiles' }, { stringValue: 'ok' }],
        [{ stringValue: 'stash-grant' }, { stringValue: 'ok' }],
      ])
    );
    // The hung poll has not reported: it overruns only after its report bound.
    expect(steps.some(([step]) => JSON.stringify(step).includes('pairing-poll'))).toBe(false);
  });
});

describe('LocationSharingService — native node adoption', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    resetEventLogForTesting();
  });

  it('probes the binary for node adoption on an interactive start', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    expect(mockHolder.mod.adoptionProbes).toBeGreaterThan(0);
  });

  it('still starts on a binary that clobbers, where the idle wait is still required', async () => {
    mockHolder.mod.adoptsNode = false;
    const svc = makeService();
    await svc.init('@me', 'mothman');
    expect(mockHolder.mod.createNodeCalls).toBe(1);
  });

  it('still starts on a binary predating the probe entirely', async () => {
    // A phone can be running an older binary than the JS bundle, so absence must degrade to the
    // old behaviour rather than throwing on the launch path.
    mockHolder.mod.omitAdoptionProbe = true;
    const svc = makeService();
    await svc.init('@me', 'mothman');
    expect(mockHolder.mod.createNodeCalls).toBe(1);
  });
});

describe('LocationSharingService — what the native drain did while JS was away', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
  });

  // The replica keeps one slot per author, so reading it back gave the own trail — and the
  // exploration map drawn from it — one point for a whole stretch published with no JS alive.
  it('fills our own trail with every position native published, not just the latest', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    const at = (ts: number) => ({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts });
    mockHolder.mod.ownPublished = [
      { seq: 41, fix: at(1_000) },
      { seq: 42, fix: at(2_000) },
      { seq: 43, fix: at(3_000) },
    ];

    await svc.syncTrail(0);

    const own = await svc.selfTrail(0);
    expect(own.map((p) => p.seq)).toEqual(expect.arrayContaining([41, 42, 43]));
    expect(mockHolder.mod.ownPublished).toHaveLength(0);
  });
});
