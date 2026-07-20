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
    syncTrail: [] as { since: number; peerTicket: string | null; traceparent?: string }[],
    importDocTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    unsubscribe: [] as string[],
    shutdownIfOwned: [] as string[],
    shutdown: 0,
  };
  private handlers: Record<string, (e: unknown) => void> = {};
  readonly unsubscribeFailures = new Set<string>();
  private nextRuntime = 1;
  currentRuntimeId: string | null = null;

  async createNode() {
    this.currentRuntimeId = `runtime-${this.nextRuntime++}`;
    return {
      endpointId: 'aa11',
      identitySecret: 'ii',
      recvSecret: 'rr',
      recvPublic: 'rp',
      runtimeId: this.currentRuntimeId,
    };
  }
  async start() {}
  async shutdown() {
    this.calls.shutdown += 1;
    this.currentRuntimeId = null;
  }
  async shutdownIfOwned(runtimeId: string) {
    this.calls.shutdownIfOwned.push(runtimeId);
    if (this.currentRuntimeId !== runtimeId) return false;
    this.currentRuntimeId = null;
    return true;
  }
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
  async syncTrail(since: number, peerTicket: string | null, traceparent?: string | null) {
    this.calls.syncTrail.push({
      since,
      peerTicket,
      ...(traceparent ? { traceparent } : {}),
    });
  }
  trailFixes: {
    author: string;
    seq: number;
    fix: { lat: number; lon: number; accuracyM: number; headingDeg: number; ts: number };
  }[] = [];
  async readTrail(author: string, sinceTs: number) {
    return this.trailFixes.filter((f) => f.author === author && f.fix.ts >= sinceTs);
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

// eslint-disable-next-line import/first
import { LocationSharingService, type SharingSnapshot } from '../location-sharing';

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
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    expect(mockHolder.mod.calls.importDocTicket).toContain('doc-b');
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-bb22')).toBe(true);
  });

  it('does not let stale service teardown clear a newer foreground runtime', async () => {
    const staleHeadless = new LocationSharingService();
    await staleHeadless.init('@me', 'mothman', '', '', { mode: 'headless' });
    const staleRuntimeId = mockHolder.mod.currentRuntimeId;

    const foreground = new LocationSharingService();
    await foreground.init('@me', 'mothman');
    const foregroundRuntimeId = mockHolder.mod.currentRuntimeId;
    expect(foregroundRuntimeId).not.toBe(staleRuntimeId);

    await staleHeadless.shutdownAsync();

    expect(mockHolder.mod.calls.shutdownIfOwned).toContain(staleRuntimeId);
    expect(mockHolder.mod.currentRuntimeId).toBe(foregroundRuntimeId);
    await expect(foreground.syncTrail(0)).resolves.toBeUndefined();

    await foreground.shutdownAsync();
  });

  it('uses legacy shutdown when the installed native binary has no ownership API', async () => {
    Object.defineProperty(mockHolder.mod, 'shutdownIfOwned', { value: undefined });
    const service = new LocationSharingService();
    await service.init('@me', 'mothman', '', '', { mode: 'headless' });

    await service.shutdownAsync();

    expect(mockHolder.mod.calls.shutdown).toBe(1);
    expect(mockHolder.mod.currentRuntimeId).toBeNull();
  });

  it('removes a friend, revokes sharing, and tears down their subscription', async () => {
    const svc = new LocationSharingService();
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
    expect((await svc.trailLatest()).some((point) => point.author === friend.endpointId)).toBe(
      false
    );

    mockHolder.mod.emit('onFix', {
      author: friend.endpointId,
      seq: 2,
      fix: { lat: 3, lon: 4, accuracyM: 3, headingDeg: 0, ts: 200 },
    });
    await flush();
    expect((await svc.trailLatest()).some((point) => point.author === friend.endpointId)).toBe(
      false
    );
  });

  it('can re-add a friend after their old subscription fails to close', async () => {
    const svc = new LocationSharingService();
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
    const svc = new LocationSharingService();
    await svc.init('@me', '  /\\\n (oo)', 'Tunnel Oracle', '#337FBE');
    expect(svc.selfCard()).toMatchObject({
      handle: '@me',
      sigil: '  /\\\n (oo)',
      cryptidName: 'Tunnel Oracle',
      color: '#337FBE',
    });
  });

  it('mirrors each published fix to the durable docs path with the same seq', async () => {
    const svc = new LocationSharingService();
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

  it('passes the local publish trace context across the native boundary', async () => {
    const parent: SpanContext = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    setTelemetryForTesting(
      createTelemetry({
        endpoint: 'http://collector.test',
        transport: async () => {},
      })
    );
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    await svc.shareWith(friend.endpointId);

    await svc.publishFix({ lat: 1, lon: 2, accuracyM: 5, headingDeg: 0, ts: 123 }, parent);

    const publishTraceparent = mockHolder.mod.calls.publish[0][5];
    expect(publishTraceparent).toMatch(new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`));
    expect(mockHolder.mod.calls.docsWrite[0][5]).toBe(publishTraceparent);

    await svc.syncTrail(0, parent);

    expect(mockHolder.mod.calls.syncTrail.at(-1)?.traceparent).toMatch(
      new RegExp(`^00-${parent.traceId}-[0-9a-f]{16}-01$`)
    );
  });

  it('syncTrail triggers native range reconciliation', async () => {
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    await svc.syncTrail(0);
    expect(mockHolder.mod.calls.syncTrail).toEqual([{ since: 0, peerTicket: null }]);
  });

  it('syncTrail explicitly targets the configured stash when opted in', async () => {
    mockHolder.stashConfig = {
      baseUrl: 'https://stash.example.com',
      ticket: 'ticket-stash',
      psk: null,
    };
    const stash = {
      configured: true,
      registerNamespace: async () => {},
      unsubscribe: async () => {},
    };
    const pushTokens = {
      acquire: async () => null,
      registerBackgroundSync: () => {},
    };
    const svc = new LocationSharingService({ stash, pushTokens });
    await svc.init('@me', 'mothman');
    await svc.setStashOptIn(true);

    await svc.syncTrail(123);

    expect(mockHolder.mod.calls.syncTrail).toContainEqual({
      since: 123,
      peerTicket: 'ticket-stash',
    });
  });

  it('syncTrail reads the durable replica into the trail (silent reconciliation)', async () => {
    const svc = new LocationSharingService();
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
    const latest = await svc.trailLatest();
    expect(latest.some((p) => p.author === 'bb22' && p.seq === 7)).toBe(true);
  });

  it('routes a backfill onFix into the trail and flags it', async () => {
    const svc = new LocationSharingService();
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
    const latest = await svc.trailLatest();
    expect(latest.some((p) => p.author === 'bb22' && p.seq === 5)).toBe(true);
  });

  it('exposes the full retained trail for known friends', async () => {
    const svc = new LocationSharingService();
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

    const full = await svc.trailAll();
    expect(
      full.filter((point) => point.author === 'bb22' && point.seq >= 51).map((point) => point.seq)
    ).toEqual([51, 52]);
  });

  it('surfaces the recovered count from onSync into the snapshot', async () => {
    const svc = new LocationSharingService();
    let recovered: number | null = null;
    svc.onChange((s) => {
      recovered = s.lastSyncRecovered;
    });
    await svc.init('@me', 'mothman');

    mockHolder.mod.emit('onSync', { author: 'bb22', status: 'completed', recovered: 3 });
    expect(recovered).toBe(3);
  });
});
