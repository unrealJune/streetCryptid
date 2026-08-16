import { setTelemetryForTesting } from '@/features/dev/telemetry';
import type { Telemetry } from '@/features/dev/telemetry';

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
    pushTrail: [] as { peerTickets: string[] }[],
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
  async pushTrail(peerTickets: string[]) {
    this.calls.pushTrail.push({ peerTickets });
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
  return { stash: { configured: true, registerNamespace: async () => {} } };
}

/**
 * Capture what the service reports. `pushTrail` is best-effort by contract — it never rethrows,
 * because a failed durable mirror must not take down the tick that already went out over gossip —
 * so its telemetry log is the only place a caller can observe that delivery is broken.
 */
const warnings: string[] = [];

function captureTelemetry(): void {
  const span = {
    context: { traceId: '0'.repeat(32), spanId: '0'.repeat(16) },
    setAttribute: () => {},
    setAttributes: () => {},
    addEvent: () => {},
    recordError: () => {},
    setStatus: () => {},
    end: () => {},
  };
  const telemetry: Telemetry = {
    enabled: false,
    startSpan: () => span,
    withSpan: async (_name, _opts, fn) => fn(span),
    log: (_severity, body) => {
      warnings.push(body);
    },
    setResourceAttributes: () => {},
    flush: async () => {},
  };
  setTelemetryForTesting(telemetry);
}

afterAll(() => setTelemetryForTesting(undefined));

describe('LocationSharingService — headless init', () => {
  beforeEach(() => {
    warnings.length = 0;
    captureTelemetry();
    mockHolder.mod = new FakeNativeModule();
    mockHolder.stashConfig = null;
    mockHolder.stashOptIn = false;
    mockHolder.pool = {
      friends: { [friendA.endpointId]: friendA, [friendB.endpointId]: friendB },
      sharingWith: [friendA.endpointId, friendB.endpointId],
    };
  });

  it('re-opens every friend trail namespace so a background backfill has something to reconcile', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.importDocTicket.sort()).toEqual(['doc-b', 'doc-c']);
  });

  it('still skips gossip subscriptions in headless mode (nothing is listening)', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.subscribe.map((s) => s.topic)).not.toContain('topic-bb22');
  });

  it('pushes the durable trail to the opted-in stash and to every pool member', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = true;
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.pushTrail();

    expect(mockHolder.mod.calls.pushTrail).toEqual([
      { peerTickets: ['ticket-stash', 'ticket-b', 'ticket-c'] },
    ]);
  });

  /**
   * The whole point of the pool push: with the stash off there is no durable copy anywhere else,
   * so if this regressed to a no-op a friend could only relay a fix it had never been sent — which
   * is exactly the peer-relay gap `scripts/e2e/relay-e2e.sh` was chasing.
   */
  it('still pushes to the pool when the stash is configured but not opted into', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = false;
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.pushTrail();

    expect(mockHolder.mod.calls.pushTrail).toEqual([{ peerTickets: ['ticket-b', 'ticket-c'] }]);
  });

  /**
   * Not a supported configuration — an iOS dev client whose Swift bindings predate the export is
   * a build that needs `just bindgen-ios`. Silently no-oping would strand every fix on the device
   * and present as the exact delivery bug this call exists to prevent, so it has to be loud.
   */
  it('reports a binary whose bindings predate pushTrail rather than silently dropping fixes', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.stashOptIn = true;
    // Assigned on the INSTANCE: `pushTrail` is a prototype method, so `delete` on the instance
    // silently does nothing and the test would pass without ever exercising the guard.
    (mockHolder.mod as unknown as Record<string, unknown>).pushTrail = undefined;
    const svc = makeService(stashDeps());
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.pushTrail();

    expect(warnings.some((line) => /pushTrail is missing/.test(line))).toBe(true);
  });
});
