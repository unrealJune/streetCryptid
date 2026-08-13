import { AppState } from 'react-native';

import type { ContactCard, IncomingFix } from '../../core/types';
import {
  createTelemetry,
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
    syncLatest: [] as { peerTicket: string | null; traceparent?: string }[],
    importDocTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    unsubscribe: [] as string[],
    docsWriteControl: [] as unknown[][],
  };
  private handlers: Record<string, (e: unknown) => void> = {};
  readonly unsubscribeFailures = new Set<string>();

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
  }
  async docsWrite(...args: unknown[]) {
    this.calls.docsWrite.push(args);
  }
  async docsWriteControl(...args: unknown[]) {
    this.calls.docsWriteControl.push(args);
  }
  async syncLatest(peerTicket: string | null, traceparent?: string | null) {
    this.calls.syncLatest.push({
      peerTicket,
      ...(traceparent ? { traceparent } : {}),
    });
  }
  trailFixes: {
    author: string;
    seq: number;
    fix: { lat: number; lon: number; accuracyM: number; headingDeg: number; ts: number };
  }[] = [];
  async readLatest() {
    // One overwritten slot per author: a read yields each author's current fix, nothing behind it.
    const current = new Map<string, (typeof this.trailFixes)[number]>();
    for (const f of this.trailFixes) {
      const held = current.get(f.author);
      if (!held || f.fix.ts > held.fix.ts || (f.fix.ts === held.fix.ts && f.seq > held.seq)) {
        current.set(f.author, f);
      }
    }
    return [...current.values()];
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
const appStateListeners = new Set<(s: string) => void>();

/** Drive an AppState transition through every listener the service installed. */
function emitAppState(next: string): void {
  for (const cb of [...appStateListeners]) cb(next);
}

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

    const publishTraceparent = mockHolder.mod.calls.publish[0][5];
    expect(publishTraceparent).toMatch(new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`));
    expect(mockHolder.mod.calls.docsWrite[0][5]).toBe(publishTraceparent);

    await svc.syncTrail(0, parent);

    expect(mockHolder.mod.calls.syncLatest.at(-1)?.traceparent).toMatch(
      new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`)
    );
  });

  it('syncTrail triggers native range reconciliation', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.syncTrail(0);
    expect(mockHolder.mod.calls.syncLatest).toEqual([{ peerTicket: null }]);
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
      peerTicket: 'ticket-stash',
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

/**
 * The WATCHER half of live mode. Live mode used to be entirely send-side: the subject sped up, but
 * nothing on this end pulled any faster, so a watcher whose gossip link was not carrying — the
 * normal case for a distant friend behind a relay — saw the whole window arrive in one batch on
 * some later unrelated sync. These cover the pull loop and, just as importantly, that it can never
 * outlive the session it serves.
 */
describe('LocationSharingService — live watch pull', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    setTelemetryForTesting(undefined);
    appStateListeners.clear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _event: string,
      cb: (state: string) => void
    ) => {
      appStateListeners.add(cb);
      return { remove: () => appStateListeners.delete(cb) };
    }) as unknown as typeof AppState.addEventListener);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** A service with a friend added and sharing on, ready to be asked to watch. */
  async function watching(): Promise<LocationSharingService> {
    const svc = makeService({ randomBytes: async (n: number) => new Uint8Array(n).fill(7) });
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);
    return svc;
  }

  /** syncTrail calls since a mark, ignoring the ones add/share themselves trigger. */
  function syncsSince(svc: LocationSharingService, mark: number): number {
    void svc;
    return mockHolder.mod.calls.syncLatest.length - mark;
  }

  it('pulls the trail on an interval while a live session is active', async () => {
    const svc = await watching();
    await svc.requestLive(friend.endpointId, 5 * 60_000);
    const mark = mockHolder.mod.calls.syncLatest.length;

    await jest.advanceTimersByTimeAsync(8_000);
    expect(syncsSince(svc, mark)).toBe(1);

    await jest.advanceTimersByTimeAsync(24_000);
    expect(syncsSince(svc, mark)).toBe(4);
  });

  it('writes the request into our own namespace rather than uploading anything', async () => {
    const svc = await watching();
    await svc.requestLive(friend.endpointId, 5 * 60_000);

    // Wrapped for exactly one recipient: nobody else, including the stash, can tell a request was
    // sent, let alone to whom.
    expect(mockHolder.mod.calls.docsWriteControl).toHaveLength(1);
    expect(mockHolder.mod.calls.docsWriteControl[0][1]).toEqual([friend.recvPublic]);
  });

  it('stops pulling when the request is withdrawn', async () => {
    const svc = await watching();
    await svc.requestLive(friend.endpointId, 5 * 60_000);
    await jest.advanceTimersByTimeAsync(8_000);

    await svc.cancelLiveRequest(friend.endpointId);
    const mark = mockHolder.mod.calls.syncLatest.length;

    await jest.advanceTimersByTimeAsync(40_000);
    expect(syncsSince(svc, mark)).toBe(0);
  });

  it('stops pulling once the window it was serving has lapsed', async () => {
    const svc = await watching();
    // Clamped up to LIVE_TTL_MIN_MS (60s), so the session expires a minute in.
    await svc.requestLive(friend.endpointId, 1_000);

    await jest.advanceTimersByTimeAsync(8_000);
    const beforeExpiry = mockHolder.mod.calls.syncLatest.length;
    expect(beforeExpiry).toBeGreaterThan(0);

    await jest.advanceTimersByTimeAsync(70_000);
    const afterExpiry = mockHolder.mod.calls.syncLatest.length;

    // A lapsed session must not keep a timer alive behind it.
    await jest.advanceTimersByTimeAsync(40_000);
    expect(mockHolder.mod.calls.syncLatest.length).toBe(afterExpiry);
  });

  // Backgrounding withdraws the ask: a watcher not looking at the screen has no use for a friend's
  // real-time GPS, and leaving it standing keeps their phone at the live cadence for the whole TTL.
  it('withdraws the request and stops pulling when the app is backgrounded', async () => {
    const svc = await watching();
    await svc.requestLive(friend.endpointId, 5 * 60_000);
    await jest.advanceTimersByTimeAsync(8_000);

    emitAppState('background');
    await jest.advanceTimersByTimeAsync(0);

    // A cancel is written into our control slot, superseding the request.
    expect(mockHolder.mod.calls.docsWriteControl.length).toBeGreaterThanOrEqual(2);

    const mark = mockHolder.mod.calls.syncLatest.length;
    await jest.advanceTimersByTimeAsync(40_000);
    expect(syncsSince(svc, mark)).toBe(0);
  });

  it('does not overlap ticks when a sync runs longer than the interval', async () => {
    const svc = await watching();
    const original = mockHolder.mod.syncLatest.bind(mockHolder.mod);
    const gates: (() => void)[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    mockHolder.mod.syncLatest = async (...args: Parameters<typeof original>) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await original(...args);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
    };

    await svc.requestLive(friend.endpointId, 5 * 60_000);
    // Four ticks' worth of interval against a sync that never finishes on its own.
    await jest.advanceTimersByTimeAsync(32_000);

    expect(maxConcurrent).toBe(1);

    // Let the held sync finish so nothing is left pending when the test ends.
    for (const open of gates.splice(0)) open();
    await jest.advanceTimersByTimeAsync(0);
    mockHolder.mod.syncLatest = original;
  });
});
