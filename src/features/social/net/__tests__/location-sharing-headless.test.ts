import type { PoolState } from '../../core/pool';

/**
 * Headless-init wiring. A background TaskManager/BGTask callback runs in a fresh JS context with no
 * React tree, so {@link LocationSharingService.init} takes the `headless` path and deliberately
 * skips gossip subscriptions, profile publishing and pairing polling.
 *
 * What it must NOT skip is re-opening the friends' trail namespaces: native `syncTrail` reconciles
 * the namespaces held in its handle cache, and a fresh node starts with only our own in there. When
 * this regressed, the periodic backfill still ran, still reported success, and still recovered
 * exactly nothing — the "friend's location never arrives unless the app is open" bug.
 */

class FakeNativeModule {
  calls = {
    importDocTicket: [] as string[],
    subscribe: [] as { topic: string; bootstrap: string[] }[],
    syncTrail: [] as { since: number; peerTicket: string | null }[],
    pushTrail: [] as { peerTicket: string | null }[],
    publish: [] as unknown[][],
    docsWrite: [] as unknown[][],
  };

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
  async syncTrail(since: number, peerTicket: string | null) {
    this.calls.syncTrail.push({ since, peerTicket });
  }
  async pushTrail(peerTicket: string | null) {
    this.calls.pushTrail.push({ peerTicket });
  }
  async readTrail() {
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
} = { mod: new FakeNativeModule(), stashConfig: null, pool: null, stashOptIn: false };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => mockHolder.stashConfig,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

jest.mock('../persistence', () => ({
  ...jest.requireActual('../persistence'),
  loadPool: async () => mockHolder.pool,
  savePool: async () => {},
  loadStashOptIn: async () => mockHolder.stashOptIn,
  saveStashOptIn: async () => {},
}));

// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

const friendA = {
  endpointId: 'bb22',
  handle: '@bee',
  sigil: 'jackalope',
  recvPublic: 'b0b0',
  ticket: 'ticket-b',
  docTicket: 'doc-b',
};
const friendB = {
  endpointId: 'cc33',
  handle: '@cee',
  sigil: 'mothman',
  recvPublic: 'c0c0',
  ticket: 'ticket-c',
  docTicket: 'doc-c',
};

function stashDeps() {
  return {
    stash: {
      configured: true,
      registerNamespace: async () => {},
      unsubscribe: async () => {},
    },
    pushTokens: { acquire: async () => null, registerBackgroundSync: () => {} },
  };
}

describe('LocationSharingService — headless init', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    mockHolder.stashOptIn = false;
    mockHolder.pool = {
      friends: { [friendA.endpointId]: friendA, [friendB.endpointId]: friendB },
      sharingWith: [friendA.endpointId, friendB.endpointId],
    };
  });

  it('re-opens every friend trail namespace so a background backfill has something to reconcile', async () => {
    const svc = new LocationSharingService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.importDocTicket.sort()).toEqual(['doc-b', 'doc-c']);
  });

  it('still skips gossip subscriptions in headless mode (nothing is listening)', async () => {
    const svc = new LocationSharingService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.subscribe.map((s) => s.topic)).not.toContain('topic-bb22');
  });

  it('pushes the durable trail to the opted-in stash', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = true;
    const svc = new LocationSharingService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.pushTrail();

    expect(mockHolder.mod.calls.pushTrail).toEqual([{ peerTicket: 'ticket-stash' }]);
  });

  it('does not push when the stash is configured but not opted into', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = false;
    const svc = new LocationSharingService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.pushTrail();

    expect(mockHolder.mod.calls.pushTrail).toEqual([]);
  });

  it('degrades to a no-op against a binary whose bindings predate pushTrail', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = true;
    delete (mockHolder.mod as Partial<FakeNativeModule>).pushTrail;
    const svc = new LocationSharingService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await expect(svc.pushTrail()).resolves.toBeUndefined();
  });
});
