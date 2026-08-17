import { CTL_KIND_LIVE_CANCEL, CTL_KIND_LIVE_REQUEST } from 'iroh-location';

import type { PoolState } from '../../core/pool';
import { CONTROL_WIRE_VERSION, LIVE_TTL_DEFAULT_MS } from '../live-requests';

/**
 * End-to-end wiring of the live-mode request channel (ARCHITECTURE §9c) through
 * {@link LocationSharingService}: sending a request, and the receive-side poll that turns a friend's
 * control entry into an armed live session.
 *
 * The pure decision logic lives in `live-requests.test.ts`; what is exercised here is the wiring the
 * unit tests cannot see — that a request is wrapped for exactly one friend, that it is PUSHED and
 * not just written locally, that the poll reconciles before reading, and that the engine's live mode
 * actually follows the resulting sessions.
 */

interface ControlMsgLike {
  v: number;
  kind: number;
  ts: number;
  ttlMs: number;
  nonce: string;
}

class FakeNativeModule {
  calls = {
    syncLatest: [] as { peerTickets: string[] }[],
    pushTrail: [] as { peerTickets: string[] }[],
    docsWriteControl: [] as { msg: ControlMsgLike; recipients: string[] }[],
    readControl: [] as string[],
  };
  /** Control messages the fake replica will hand back, by author. */
  control: Record<string, ControlMsgLike[]> = {};

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
  async importDocTicket() {}
  async deriveTopic(id: string) {
    return `topic-${id}`;
  }
  async subscribe(topic: string) {
    return `sub-${topic}`;
  }
  async unsubscribe() {}
  async publish() {}
  async docsWrite() {}
  async syncLatest(peerTickets: string[]) {
    this.calls.syncLatest.push({ peerTickets });
  }
  async pushTrail(peerTickets: string[]) {
    this.calls.pushTrail.push({ peerTickets });
  }
  async docsWriteControl(msg: ControlMsgLike, recipients: string[]) {
    this.calls.docsWriteControl.push({ msg, recipients });
  }
  async readControl(author: string) {
    this.calls.readControl.push(author);
    return this.control[author] ?? [];
  }
  async readLatest() {
    return [];
  }
  async pruneTrail() {}
  addListener() {
    return { remove: () => {} };
  }
}

const mockHolder: {
  mod: FakeNativeModule;
  stashConfig: { baseUrl: string; ticket: string; psk: null } | null;
  pool: PoolState | null;
  stashOptIn: boolean;
  handled: { nonce: string; at: number }[];
} = {
  mod: new FakeNativeModule(),
  stashConfig: { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null },
  pool: null,
  stashOptIn: true,
  handled: [],
};

jest.mock('iroh-location', () => ({
  ...jest.requireActual('iroh-location'),
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => mockHolder.stashConfig,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

jest.mock('expo-crypto', () => ({
  getRandomBytesAsync: async (n: number) => new Uint8Array(n).fill(0xab),
}));

jest.mock('../persistence', () => ({
  ...jest.requireActual('../persistence'),
  loadPool: async () => mockHolder.pool,
  savePool: async () => {},
  loadStashOptIn: async () => mockHolder.stashOptIn,
  saveStashOptIn: async () => {},
  loadHandledNonces: async () => mockHolder.handled,
  saveHandledNonces: async (_kv: unknown, h: { nonce: string; at: number }[]) => {
    mockHolder.handled = h;
  },
}));

// eslint-disable-next-line import/first
import { LocationSharingService, type LiveSnapshot } from '../location-sharing';

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

const friend = {
  endpointId: 'bb22',
  handle: '@bee',
  sigil: 'jackalope',
  recvPublic: 'b0b0',
  ticket: 'ticket-b',
  docTicket: 'doc-b',
};

function stashDeps() {
  return { stash: { configured: true, registerNamespace: async () => {} } };
}

function msg(overrides: Partial<ControlMsgLike> = {}): ControlMsgLike {
  return {
    v: CONTROL_WIRE_VERSION,
    kind: CTL_KIND_LIVE_REQUEST,
    ts: Date.now(),
    ttlMs: LIVE_TTL_DEFAULT_MS,
    nonce: 'ab'.repeat(16),
    ...overrides,
  };
}

/** Reach the private poll without exporting it just for tests. */
async function poll(svc: LocationSharingService): Promise<void> {
  await (svc as unknown as { pollLiveRequestsOnce(): Promise<void> }).pollLiveRequestsOnce();
}

/** The current live snapshot. `onChange` invokes the listener synchronously on subscribe. */
function live(svc: LocationSharingService): LiveSnapshot {
  let captured: LiveSnapshot | null = null;
  svc.onChange((next) => {
    captured = next.live;
  })();
  if (!captured) throw new Error('no snapshot emitted');
  return captured;
}

describe('live mode — sending a request', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.handled = [];
    mockHolder.pool = {
      friends: { [friend.endpointId]: friend },
      sharingWith: [friend.endpointId],
    };
  });

  it('wraps the request for exactly that friend and nobody else', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');

    await svc.requestLive(friend.endpointId);

    expect(mockHolder.mod.calls.docsWriteControl).toHaveLength(1);
    const { msg: sent, recipients } = mockHolder.mod.calls.docsWriteControl[0];
    // One recipient means the stash and every other pool member see only opaque bytes.
    expect(recipients).toEqual([friend.recvPublic]);
    expect(sent.kind).toBe(CTL_KIND_LIVE_REQUEST);
    expect(sent.v).toBe(CONTROL_WIRE_VERSION);
    expect(sent.nonce).toBe('ab'.repeat(16));
  });

  it('pushes after writing, or the request never leaves the phone', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');

    await svc.requestLive(friend.endpointId);

    // docsWriteControl only touches the local replica; without the push the friend polls forever.
    expect(mockHolder.mod.calls.pushTrail).toContainEqual({
      peerTickets: ['ticket-stash', friend.ticket],
    });
  });

  it('surfaces who we have asked', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    await svc.requestLive(friend.endpointId);
    expect(live(svc).watching).toEqual([friend.endpointId]);
  });

  it('refuses to ask a stranger', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    await expect(svc.requestLive('nope')).rejects.toThrow(/not a friend/);
  });

  it('supersedes the request with a cancel', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    await svc.requestLive(friend.endpointId);

    await svc.cancelLiveRequest(friend.endpointId);

    const kinds = mockHolder.mod.calls.docsWriteControl.map((c) => c.msg.kind);
    expect(kinds).toEqual([CTL_KIND_LIVE_REQUEST, CTL_KIND_LIVE_CANCEL]);
    expect(live(svc).watching).toEqual([]);
  });
});

describe('live mode — receiving a request', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.handled = [];
    mockHolder.pool = {
      friends: { [friend.endpointId]: friend },
      sharingWith: [friend.endpointId],
    };
  });

  it('reconciles before reading — an unpulled request is invisible', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.calls.syncLatest.length = 0;

    await poll(svc);

    expect(mockHolder.mod.calls.syncLatest.length).toBeGreaterThan(0);
    expect(mockHolder.mod.calls.readControl).toContain(friend.endpointId);
  });

  it('arms a live session for a friend we share with, with no prompt', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];

    await poll(svc);

    const snapshot = live(svc);
    expect(snapshot.watchers.map((w) => w.author)).toEqual([friend.endpointId]);
    expect(snapshot.liveUntil).not.toBeNull();
  });

  it('ignores a request from someone we have revoked', async () => {
    mockHolder.pool = { friends: { [friend.endpointId]: friend }, sharingWith: [] };
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];

    await poll(svc);

    expect(live(svc).watchers).toEqual([]);
  });

  it('does not re-arm on a second poll of the same still-present entry', async () => {
    // The sender's slot keeps serving the same message; re-arming would silently extend the window.
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];

    await poll(svc);
    const firstExpiry = live(svc).watchers[0].expiresAt;
    await poll(svc);

    expect(live(svc).watchers[0].expiresAt).toBe(firstExpiry);
  });

  it('stops the session when the watcher cancels', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];
    await poll(svc);
    expect(live(svc).watchers).toHaveLength(1);

    // A cancel supersedes the request in the sender's single slot — a fresh nonce so it is acted on.
    mockHolder.mod.control[friend.endpointId] = [
      msg({ kind: CTL_KIND_LIVE_CANCEL, nonce: 'cd'.repeat(16) }),
    ];
    await poll(svc);

    expect(live(svc).watchers).toEqual([]);
    expect(live(svc).liveUntil).toBeNull();
  });

  it('stops a session on the user’s explicit stop', async () => {
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];
    await poll(svc);

    await svc.stopWatcher(friend.endpointId);

    expect(live(svc).watchers).toEqual([]);
  });

  it('remembers handled nonces across a restart', async () => {
    const first = makeService(stashDeps());
    await first.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg()];
    await poll(first);
    expect(mockHolder.handled.map((h) => h.nonce)).toEqual(['ab'.repeat(16)]);

    // A fresh service (process restart) must not re-arm from the same still-current entry.
    const second = makeService(stashDeps());
    await second.init('@me', 'mothman');
    await poll(second);

    expect(live(second).watchers).toEqual([]);
  });

  it('ignores a stale entry without burning its nonce', async () => {
    // A later legitimate re-send of the same message must still be actionable, so a `stale` verdict
    // must not be recorded as handled.
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman');
    mockHolder.mod.control[friend.endpointId] = [msg({ ts: Date.now() - 60 * 60_000 })];

    await poll(svc);

    expect(live(svc).watchers).toEqual([]);
    expect(mockHolder.handled).toEqual([]);
  });
});
