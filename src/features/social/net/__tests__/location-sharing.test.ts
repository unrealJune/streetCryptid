import type { ContactCard, IncomingFix } from '../../core/types';

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
    syncTrail: [] as number[],
    importDocTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
  };
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
  async unsubscribe() {}
  async publish(...args: unknown[]) {
    this.calls.publish.push(args);
  }
  async docsWrite(...args: unknown[]) {
    this.calls.docsWrite.push(args);
  }
  async syncTrail(since: number) {
    this.calls.syncTrail.push(since);
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

const mockHolder: { mod: FakeNativeModule } = { mod: new FakeNativeModule() };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
}));

// Keep persistence + key storage side-effect-free in the test (fall back to in-memory).
jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

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
  });

  it('imports a friend docs namespace (their docTicket) when added', async () => {
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    expect(mockHolder.mod.calls.importDocTicket).toContain('doc-b');
    expect(mockHolder.mod.calls.subscribe.some((s) => s.topic === 'topic-bb22')).toBe(true);
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

  it('syncTrail triggers native range reconciliation', async () => {
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman');
    await svc.syncTrail(0);
    expect(mockHolder.mod.calls.syncTrail).toEqual([0]);
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
