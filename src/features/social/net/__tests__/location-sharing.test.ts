import type { ContactCard, IncomingFix } from '../../core/types';
import {
  createTelemetry,
  resetEventLogForTesting,
  setTelemetryForTesting,
  type SpanContext,
} from '@/features/dev/telemetry';

/**
 * Wiring tests for the durable-trail / sync path in {@link LocationSharingService}, using a fake
 * native module. These prove the plumbing (import friend namespace on add, mirror to docs on
 * publish, trigger reconciliation, route backfill fixes into the trail, surface recovered count)
 * without a live iroh node — the real range-reconciliation is exercised end-to-end (two browsers /
 * two devices) per docs/social/ARCHITECTURE.md §9.
 */

class FakeNativeModule {
  calls = {
    publish: [] as unknown[][],
    docsWrite: [] as unknown[][],
    publishNull: [] as unknown[][],
    docsWriteNull: [] as unknown[][],
    syncLatest: [] as { peerTickets: string[]; traceparent?: string }[],
    importDocTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    unsubscribe: [] as string[],
    docsWriteControl: [] as unknown[][],
    pollResync: [] as { peer: string; recvPub: string }[],
    forgetSession: [] as string[],
    clearResync: 0,
    setDeliveryConfig: [] as {
      peerTickets: string[];
      stashBaseUrl: string | null;
      stashPsk: string | null;
    }[],
  };
  private handlers: Record<string, (e: unknown) => void> = {};
  readonly unsubscribeFailures = new Set<string>();

  // ── ratchet state the fake pretends to hold (FORWARD-SECRECY.md §4.5, §4.6) ──────────────
  /** Recipients every ratcheted publish reports as dropped, as "<endpointId>:<reason>". */
  droppedRecipients: string[] = [];
  /** Endpoint ids `isDesynced` should answer `true` for. */
  readonly desynced = new Set<string>();
  /** Endpoint id → how many resyncs have already been driven with them. */
  readonly resyncCounts = new Map<string, number>();
  /** Endpoint ids whose next `pollResync` should report a session installed. */
  readonly resyncSucceeds = new Set<string>();

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
  async importDocTicket(ticket: string) {
    this.calls.importDocTicket.push(ticket);
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
    if (this.unsubscribeFailures.has(subscriptionId)) {
      throw new Error(`unsubscribe failed: ${subscriptionId}`);
    }
  }
  async publish(...args: unknown[]) {
    this.calls.publish.push(args);
    return this.droppedRecipients;
  }
  async docsWrite(...args: unknown[]) {
    this.calls.docsWrite.push(args);
    return this.droppedRecipients;
  }
  async publishNull(...args: unknown[]) {
    this.calls.publishNull.push(args);
    return this.droppedRecipients;
  }
  async docsWriteNull(...args: unknown[]) {
    this.calls.docsWriteNull.push(args);
    return this.droppedRecipients;
  }

  async isDesynced(peerEndpointHex: string) {
    return this.desynced.has(peerEndpointHex);
  }
  async resyncCount(peerEndpointHex: string) {
    return this.resyncCounts.get(peerEndpointHex) ?? 0;
  }
  async pollResync(peerEndpointHex: string, peerRecvPubHex: string) {
    this.calls.pollResync.push({ peer: peerEndpointHex, recvPub: peerRecvPubHex });
    if (!this.resyncSucceeds.has(peerEndpointHex)) return false;
    this.desynced.delete(peerEndpointHex);
    return true;
  }
  async clearResync() {
    this.calls.clearResync += 1;
  }
  async forgetSession(peerEndpointHex: string) {
    this.calls.forgetSession.push(peerEndpointHex);
  }
  async docsWriteControl(...args: unknown[]) {
    this.calls.docsWriteControl.push(args);
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
  trailFixes: {
    author: string;
    seq: number;
    fix: { lat: number; lon: number; accuracyM: number; headingDeg: number; ts: number };
  }[] = [];
  trailNulls: { author: string; seq: number; ts: number; kind: 'null'; fix?: undefined }[] = [];
  async readLatest() {
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
import { LocationSharingService, type SharingSnapshot } from '../location-sharing';

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
    await svc.addFriend(friend);
    expect(mockHolder.mod.calls.importDocTicket).toContain('doc-b');
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-bb22')).toBe(true);
  });

  it('removes a friend, revokes sharing, and tears down their subscription', async () => {
    const svc = makeService();
    const snapshots: SharingSnapshot[] = [];
    svc.onChange((snapshot) => snapshots.push(snapshot));
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    mockHolder.mod.emit('onFix', {
      author: friend.endpointId,
      seq: 1,
      fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 100 },
    });
    await flush();

    await svc.removeFriend(friend.endpointId);

    const latest = snapshots.at(-1);
    expect(latest?.friends).toEqual([]);
    expect(latest?.sharingWith).toEqual([]);
    expect(mockHolder.mod.calls.unsubscribe).toContain('sub-topic-bb22');
    expect((await svc.friendLatest()).some((point) => point.author === friend.endpointId)).toBe(
      false
    );

    mockHolder.mod.emit('onFix', {
      author: friend.endpointId,
      seq: 2,
      fix: { lat: 3, lon: 4, accuracyM: 3, headingDeg: 0, ts: 200 },
    });
    await flush();
    expect((await svc.friendLatest()).some((point) => point.author === friend.endpointId)).toBe(
      false
    );
  });

  it('can re-add a friend after their old subscription fails to close', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    mockHolder.mod.unsubscribeFailures.add('sub-topic-bb22');

    await svc.removeFriend(friend.endpointId);
    await svc.addFriend(friend);

    const friendSubscriptions = mockHolder.mod.calls.subscribe.filter(
      ({ topic }) => topic === 'topic-bb22'
    );
    expect(friendSubscriptions).toHaveLength(2);
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

  it('mirrors each published fix to the durable docs path with the same seq', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    const seq = await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });
    expect(seq).toBeGreaterThan(0);
    expect(mockHolder.mod.calls.publish).toHaveLength(1);
    expect(mockHolder.mod.calls.docsWrite).toHaveLength(1);
    expect(mockHolder.mod.calls.publish[0][1]).toBe(seq);
    expect(mockHolder.mod.calls.docsWrite[0][1]).toBe(seq);
  });

  it('forces a supplied fix through the publish path without sampling', async () => {
    const svc = makeService();
    Object.assign(svc, { mod: mockHolder.mod, status: 'ready' });
    const fix = { lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 };
    const publish = jest.spyOn(svc, 'publishFix').mockResolvedValue(9);

    await expect(svc.forceLocationPush(fix, 'scheduled')).resolves.toBe(9);

    expect(publish).toHaveBeenCalledWith(fix, expect.any(Object));
  });

  it('passes the local publish trace context across the native boundary', async () => {
    const parent: SpanContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    setTelemetryForTesting(
      createTelemetry({
        endpoint: 'http://collector.test',
        transport: async () => {},
      })
    );
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 }, parent);

    // Last argument, rather than a fixed index: the epoch parameter was removed from both calls
    // when the mesh and docs epochs were split (FORWARD-SECRECY.md §7 step 4).
    const publishTraceparent = mockHolder.mod.calls.publish[0].at(-1);
    expect(publishTraceparent).toMatch(new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`));
    expect(mockHolder.mod.calls.docsWrite[0].at(-1)).toBe(publishTraceparent);

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
    await svc.setStashOptIn(true);

    await svc.syncTrail(123);

    expect(mockHolder.mod.calls.syncLatest).toContainEqual({
      peerTickets: ['ticket-stash'],
    });
  });

  it('records configured stash replication on the publish trace', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const sent: {
      resourceSpans?: {
        scopeSpans?: {
          spans?: { name: string; attributes: unknown; events: unknown }[];
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
    const svc = makeService({
      stash: { configured: true, registerNamespace: async () => {} },
    });
    await svc.init('@me', 'mothman');
    await svc.setStashOptIn(true);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });
    await telemetry.flush();

    const publishSpan = sent
      .flatMap((payload) => payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? [])
      .find((span) => span.name === 'publish.fix');
    if (!publishSpan) throw new Error('publish.fix span was not exported');
    expect(publishSpan.attributes).toEqual(
      expect.arrayContaining([
        { key: 'stash.client_configured', value: { boolValue: true } },
        { key: 'stash.ticket_configured', value: { boolValue: true } },
        { key: 'stash.opted_in', value: { boolValue: true } },
        { key: 'stash.replication_enabled', value: { boolValue: true } },
      ])
    );
    expect(publishSpan.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'docs.write.completed',
          attributes: expect.arrayContaining([
            { key: 'stash.replication_enabled', value: { boolValue: true } },
          ]),
        }),
      ])
    );
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

  it('routes a backfill onFix into the trail and flags it', async () => {
    const svc = makeService();
    const received: IncomingFix[] = [];
    svc.onFix((f) => received.push(f));
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.emit('onFix', {
      author: 'bb22',
      seq: 5,
      fix: { lat: 10, lon: 20, accuracyM: 3, headingDeg: 0, ts: 999 },
      backfill: true,
    });
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].backfill).toBe(true);
    const latest = await svc.friendLatest();
    expect(latest.some((p) => p.author === 'bb22' && p.seq === 5)).toBe(true);
  });

  it('keeps only the newest fix per friend in the trail cache', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.emit('onFix', {
      author: 'bb22',
      seq: 51,
      fix: { lat: 10, lon: 20, accuracyM: 3, headingDeg: 0, ts: 1001 },
      backfill: false,
    });
    mockHolder.mod.emit('onFix', {
      author: 'bb22',
      seq: 52,
      fix: { lat: 11, lon: 21, accuracyM: 3, headingDeg: 0, ts: 1002 },
      backfill: false,
    });
    await flush();

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

  it('surfaces live fix and null ratchet responses per friend', async () => {
    const svc = makeService();
    let activity: SharingSnapshot['ratchetActivity'] = {};
    svc.onChange((snapshot) => {
      activity = snapshot.ratchetActivity;
    });
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.emit('onFix', {
      author: friend.endpointId,
      seq: 21,
      fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 900 },
    });
    mockHolder.mod.emit('onOpaque', { author: friend.endpointId, seq: 22, kind: 'null' });

    expect(activity[friend.endpointId]).toMatchObject({
      fix: { seq: 21, source: 'live' },
      null: { seq: 22, source: 'live' },
    });
  });

  it('surfaces a null ratchet response recovered from the durable lane', async () => {
    const svc = makeService();
    let activity: SharingSnapshot['ratchetActivity'] = {};
    svc.onChange((snapshot) => {
      activity = snapshot.ratchetActivity;
    });
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    mockHolder.mod.trailNulls = [{ author: friend.endpointId, seq: 31, ts: 1_000, kind: 'null' }];

    await svc.syncTrail(0);

    expect(activity[friend.endpointId]?.null).toMatchObject({
      seq: 31,
      source: 'durable',
    });
  });

  describe('share interval', () => {
    /** Latest snapshot seen by an observer — `snapshot()` itself is private to the service. */
    function observe(svc: LocationSharingService): () => SharingSnapshot | undefined {
      const snapshots: SharingSnapshot[] = [];
      svc.onChange((snapshot) => snapshots.push(snapshot));
      return () => snapshots.at(-1);
    }

    it('defaults to 5 minutes and surfaces it on the snapshot', async () => {
      const svc = makeService();
      const latest = observe(svc);
      await svc.init('@me', 'mothman');

      expect(latest()?.shareIntervalMs).toBe(300_000);
    });

    it('persists a chosen interval and emits the change', async () => {
      const svc = makeService();
      await svc.init('@me', 'mothman');
      const latest = observe(svc);

      await svc.setShareInterval(60_000);

      expect(latest()?.shareIntervalMs).toBe(60_000);
      // Surviving a restart is covered in share-interval.test.ts against the KV directly: under
      // jest each service builds its own InMemoryKV (no SQLite), so two instances here cannot
      // share a store.
    });

    it('ignores an off-grid interval, which would break slot alignment', async () => {
      const svc = makeService();
      await svc.init('@me', 'mothman');
      const latest = observe(svc);

      await svc.setShareInterval(37_000);

      expect(latest()?.shareIntervalMs).toBe(300_000);
    });
  });
});

describe('LocationSharingService — native delivery targets', () => {
  // Publishing is not delivery. `docsWrite` writes the LOCAL replica and iroh-docs broadcasts a
  // local insert only for namespaces the live engine has marked as syncing, which a publish-only
  // context never does — so a native drain that does not know who to push to seals correctly,
  // reports success, and delivers nothing. Two phones ran a full day in that state on 2026-08-31.
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

    await svc.setStashOptIn(true);

    const latest = mockHolder.mod.calls.setDeliveryConfig.at(-1);
    expect(latest?.stashBaseUrl).toBe('https://stash.example.com');
    // Same order as `durablePeerTickets`: the stash is always-on and usually answers immediately.
    expect(latest?.peerTickets[0]).toBe('ticket-stash');
  });

  it('stops naming the stash when the user opts back out', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = { configured: true, registerNamespace: async () => {} };
    const svc = makeService({ stash });
    await svc.init('@me', 'mothman');
    await svc.setStashOptIn(true);
    await svc.setStashOptIn(false);

    const latest = mockHolder.mod.calls.setDeliveryConfig.at(-1);
    expect(latest?.stashBaseUrl).toBeNull();
    expect(latest?.peerTickets).not.toContain('ticket-stash');
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

describe('LocationSharingService — symmetric lanes (null fixes)', () => {
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
    // The durable journal is what the shipper drains, so spans carry between tests unless it is
    // cleared here too — the telemetry singleton is no longer the whole of the exported state.
    resetEventLogForTesting();
  });

  /** A pool where we share with `friend` and merely watch `watcherFriend`. */
  async function mixedEdges(): Promise<LocationSharingService> {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.addFriend(watcherFriend);
    await svc.shareWith(friend.endpointId);
    return svc;
  }

  it('publishes a null fix to the friends it is not sharing with, on the same tick', async () => {
    const svc = await mixedEdges();

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.publishNull).toHaveLength(1);
    expect(mockHolder.mod.calls.docsWriteNull).toHaveLength(1);
    // (subscriptionId, seq, ts, watcherEndpoints, traceparent) — endpoint ids, not receiving
    // keys: the null lane is envelope v3 now, addressed by ratchet session (§4.7).
    expect(mockHolder.mod.calls.publishNull[0][2]).toBe(123);
    expect(mockHolder.mod.calls.publishNull[0][3]).toEqual([watcherFriend.endpointId]);
    expect(mockHolder.mod.calls.docsWriteNull[0][3]).toEqual([watcherFriend.endpointId]);
  });

  it('never addresses the same friend on both lanes', async () => {
    const svc = await mixedEdges();

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    const shared = mockHolder.mod.calls.publish[0][3] as string[];
    const watched = mockHolder.mod.calls.publishNull[0][3] as string[];
    expect(shared).toEqual([friend.endpointId]);
    expect(watched).toEqual([watcherFriend.endpointId]);
    expect(shared.filter((k) => watched.includes(k))).toEqual([]);
  });

  it('gives the null fix its own seq, so no two envelopes share (author, seq)', async () => {
    const svc = await mixedEdges();

    const seq = await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    const nullSeq = mockHolder.mod.calls.publishNull[0][1] as number;
    expect(nullSeq).not.toBe(seq);
    expect(mockHolder.mod.calls.docsWriteNull[0][1]).toBe(nullSeq);
    // Monotonic, like every other envelope we sign.
    expect(nullSeq).toBeGreaterThan(seq);
  });

  it('publishes nothing on the null lane when every friend is a sharing recipient', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.publish).toHaveLength(1);
    expect(mockHolder.mod.calls.publishNull).toHaveLength(0);
  });

  it('still publishes the watcher lane for a device that shares with nobody', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(watcherFriend);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.publishNull).toHaveLength(1);
    expect(mockHolder.mod.calls.publishNull[0][3]).toEqual([watcherFriend.endpointId]);
  });

  // The real fix is already on the wire and its seq returned by the time the null lane runs, so a
  // failure here must not fail the tick — that would make the outbox retain and re-publish a fix
  // that already went out.
  it('does not fail the tick when the null lane throws', async () => {
    const svc = await mixedEdges();
    mockHolder.mod.publishNull = async () => {
      throw new Error('gossip broadcast failed');
    };

    await expect(
      svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 })
    ).resolves.toBeGreaterThan(0);

    expect(mockHolder.mod.calls.publish).toHaveLength(1);
  });

  // Swift bindings only regenerate on macOS, so an installed iOS binary can predate this API.
  it('skips the null lane on a binary without the native export', async () => {
    const svc = await mixedEdges();
    // A class method lives on the prototype, so it is overwritten rather than deleted — the shape
    // an older binary presents is `typeof mod.publishNull !== 'function'`, which this reproduces.
    (mockHolder.mod as unknown as Record<string, unknown>).publishNull = undefined;

    await expect(
      svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 })
    ).resolves.toBeGreaterThan(0);

    expect(mockHolder.mod.calls.docsWriteNull).toHaveLength(0);
  });
});

/**
 * Forward-secrecy health surfacing and §4.6 recovery — FORWARD-SECRECY.md §4.5, §4.6 / §7 step 7.
 *
 * The schedule cannot heal itself and a short wrap list is not a partial success: something has to
 * notice that a friend stopped receiving fixes, say which of the three lookalike reasons it is,
 * and run the resync exchange. These pin that something.
 */
describe('LocationSharingService — session health and resync', () => {
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
   * captured reference would pin the empty one from before the publish.
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
    mockHolder.mod.droppedRecipients = [`${friend.endpointId}:no_session`];

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(health()[friend.endpointId]).toBe('needs-repair');
  });

  it('distinguishes a lapsed friend from one that needs a re-pair', async () => {
    // §4.5 asks for these to read differently to a human: lapsed means "their app has not run for
    // a day" and resolves itself the moment it does, which is not a re-pair.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.droppedRecipients = [`${friend.endpointId}:lapsed`];

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(health()[friend.endpointId]).toBe('lapsed');
  });

  it('does not surface a transient responder-window drop to the user', async () => {
    // `no_sending_chain` is a responder waiting for the initiator's first envelope. It clears
    // itself on the next tick, so putting it in front of a human would be noise.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.droppedRecipients = [`${friend.endpointId}:no_sending_chain`];

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(health()).toEqual({});
  });

  it('clears a drop once the friend is reachable again', async () => {
    // Rebuilt per publish rather than accumulated, so recovery needs no separate clearing path.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.droppedRecipients = [`${friend.endpointId}:no_session`];
    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });
    expect(health()[friend.endpointId]).toBe('needs-repair');

    mockHolder.mod.droppedRecipients = [];
    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 456 });

    expect(health()).toEqual({});
  });

  it('runs the resync exchange for a desynced friend and reports recovery', async () => {
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.desynced.add(friend.endpointId);
    mockHolder.mod.resyncSucceeds.add(friend.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.pollResync).toEqual([
      { peer: friend.endpointId, recvPub: friend.recvPublic },
    ]);
    expect(health()).toEqual({});
    // The ephemeral is dropped once nobody is mid-exchange — a private key held for no reason.
    expect(mockHolder.mod.calls.clearResync).toBe(1);
  });

  it('leaves a friend marked desynced while the exchange is still in flight', async () => {
    // The peer has not published their half yet. Ordinary: the two sides notice at different
    // times, which is exactly why `pollResync` publishes ours before looking for theirs.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.desynced.add(friend.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(health()[friend.endpointId]).toBe('desynced');
    // ...and we must NOT drop the ephemeral, or the peer's half arrives with nothing to meet it.
    expect(mockHolder.mod.calls.clearResync).toBe(0);
  });

  it('stops resyncing and asks for a re-pair once recovery keeps failing', async () => {
    // "A resync loop surfaces a 're-pair with this friend' prompt rather than retrying forever."
    // A session rebuilt three times that still does not work will not be fixed by a fourth.
    const svc = await shared();
    const health = healthOf(svc);
    mockHolder.mod.desynced.add(friend.endpointId);
    mockHolder.mod.resyncCounts.set(friend.endpointId, 3);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.pollResync).toEqual([]);
    expect(health()[friend.endpointId]).toBe('recovery-failed');
  });

  it('checks watch-only friends too, not just the ones we share with', async () => {
    // A watcher edge is a session like any other — it is how our own fixes stay openable by them
    // — so recovery must cover it. Watching only their lane would leave half the pool unhealable.
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(watcher);
    mockHolder.mod.desynced.add(watcher.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 });

    expect(mockHolder.mod.calls.pollResync.map((c) => c.peer)).toEqual([watcher.endpointId]);
  });

  it('forgets the ratchet session when a friend is removed', async () => {
    // §5.4: chain keys for a relationship that no longer exists are material whose only remaining
    // use is to a seized device.
    const svc = await shared();

    await svc.removeFriend(friend.endpointId);

    expect(mockHolder.mod.calls.forgetSession).toEqual([friend.endpointId]);
  });
});
