import { setTelemetryForTesting } from '@/features/dev/telemetry';
import type { Telemetry } from '@/features/dev/telemetry';

import type { DeliveryMode } from '../../core/delivery-mode';
import type { PoolState } from '../../core/pool';

/**
 * Headless-init wiring. A background TaskManager/BGTask callback runs in a fresh JS context with no
 * React tree, so {@link LocationSharingService.init} takes the `headless` path and deliberately
 * skips the replica watch, profile publishing and pairing polling.
 *
 * What it must NOT skip is re-opening the friends' trail namespaces: native `syncTrail` reconciles
 * the namespaces held in its handle cache, and a fresh node starts with only our own in there. When
 * this regressed, the periodic backfill still ran, still reported success, and still recovered
 * exactly nothing — the "friend's location never arrives unless the app is open" bug.
 */

class FakeNativeModule {
  calls = {
    importDocTicket: [] as string[],
    importProfileTicket: [] as string[],
    watchReplica: 0,
    syncTrail: [] as { since: number; peerTicket: string | null }[],
    setDeliveryConfig: [] as {
      peerTickets: string[];
      stashBaseUrl: string | null;
      stashPsk: string | null;
    }[],
    setSharingRecipients: [] as { recipients: string[]; watchers: string[] }[],
    setRecipientKeys: [] as { endpoints: string[]; keys: string[] }[],
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
  async importProfileTicket(ticket: string) {
    this.calls.importProfileTicket.push(ticket);
  }
  watchReplica() {
    this.calls.watchReplica += 1;
  }
  unwatchReplica() {}
  async setDeliveryConfig(
    peerTickets: string[],
    stashBaseUrl: string | null,
    stashPsk: string | null
  ) {
    this.calls.setDeliveryConfig.push({ peerTickets, stashBaseUrl, stashPsk });
  }
  async setSharingRecipients(recipients: string[], watchers: string[]) {
    this.calls.setSharingRecipients.push({ recipients, watchers });
  }
  async setRecipientKeys(endpoints: string[], keys: string[]) {
    this.calls.setRecipientKeys.push({ endpoints, keys });
  }
  async syncTrail(since: number, peerTicket: string | null) {
    this.calls.syncTrail.push({ since, peerTicket });
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
  deliveryMode: DeliveryMode;
} = { mod: new FakeNativeModule(), stashConfig: null, pool: null, deliveryMode: 'mutual' };

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
  // `loadDeliveryMode` reads the legacy `stashOptIn` key through a module-internal call, which a
  // mocked export cannot intercept — so mock the function the service actually calls.
  loadDeliveryMode: async () => mockHolder.deliveryMode,
  saveDeliveryMode: async () => {},
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

/** Capture what the service reports: its warnings are the only trace of a best-effort mirror. */
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
    mockHolder.deliveryMode = 'mutual';
    mockHolder.pool = {
      friends: { [friendA.endpointId]: friendA, [friendB.endpointId]: friendB },
      sharingWith: [friendA.endpointId, friendB.endpointId],
    };
  });

  /**
   * The mirror must carry the RESTORED pool, and the ordering is the entire behaviour.
   *
   * `pushSharingRecipients` used to run twelve lines before `restorePool`, where `this.state` was
   * still `emptyPool()`. `set_all` is durable, so every init overwrote the on-disk recipient list
   * with nothing. Interactive sessions hid it — the next pool change re-pushed the real set — but a
   * headless wake changes no pool, so it published sealed for nobody: 91 of 94 envelopes on
   * 2026-09-03 went out `recipients=0` while `device.health` read `sharing.recipients=1` from the
   * JS pool throughout. Asserting on the last call would not have caught it; the empty write is
   * the bug, wherever in init it lands.
   */
  it('mirrors the restored pool to native, and never the empty one it starts with', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setSharingRecipients).toEqual([
      { recipients: [friendA.endpointId, friendB.endpointId], watchers: [] },
    ]);
  });

  it('never hands native an empty recipient list while the pool has members', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(
      mockHolder.mod.calls.setSharingRecipients.filter((c) => c.recipients.length === 0)
    ).toEqual([]);
  });

  /**
   * The guard is "we have not looked at the pool yet", not "the list is empty" — those are the same
   * value and only one of them is wrong to send. A device that really shares with nobody must still
   * say so, or a removed friend keeps being sealed for.
   */
  it('still mirrors an empty set when the pool genuinely is empty', async () => {
    mockHolder.pool = { friends: {}, sharingWith: [] };
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setSharingRecipients).toEqual([{ recipients: [], watchers: [] }]);
  });

  it('mirrors an empty set when nothing is persisted at all, rather than skipping', async () => {
    mockHolder.pool = null;
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setSharingRecipients).toEqual([{ recipients: [], watchers: [] }]);
  });

  /** A friend we do not share position with is a watcher edge, and still needs the null lane. */
  it('splits the pool into recipients and watchers in the one call', async () => {
    mockHolder.pool = {
      friends: { [friendA.endpointId]: friendA, [friendB.endpointId]: friendB },
      sharingWith: [friendA.endpointId],
    };
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setSharingRecipients).toEqual([
      { recipients: [friendA.endpointId], watchers: [friendB.endpointId] },
    ]);
  });

  /**
   * Native session recovery (§4.6) seals its record to each friend's receiving key, and a headless
   * wake has no pool to read it from. Without this mirror the only remaining driver of recovery
   * has nothing to seal for, and a lapsed pair stays lapsed — a week of a Pixel 9 on 2026-09-29.
   * Every friend, watch-only included: a watcher edge is a session like any other.
   */
  it('mirrors every friend receiving key for native recovery, watchers included', async () => {
    mockHolder.pool = {
      friends: { [friendA.endpointId]: friendA, [friendB.endpointId]: friendB },
      sharingWith: [friendA.endpointId],
    };
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    const [call] = mockHolder.mod.calls.setRecipientKeys;
    const pairs = call.endpoints.map((e, i) => [e, call.keys[i]]).sort();
    expect(pairs).toEqual(
      [
        [friendA.endpointId, friendA.recvPublic],
        [friendB.endpointId, friendB.recvPublic],
      ].sort()
    );
  });

  it('re-opens every friend trail namespace so a background backfill has something to reconcile', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.importDocTicket.sort()).toEqual(['doc-b', 'doc-c']);
  });

  it('neither watches the replica nor imports profiles in headless mode (nothing is on screen)', async () => {
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.watchReplica).toBe(0);
    expect(mockHolder.mod.calls.importProfileTicket).toEqual([]);
  });

  /**
   * The native drain pushes every publish itself (`NodeSink::flush`), JS-free wakes included, to
   * exactly the list mirrored here. So this list IS delivery: a friend missing from it is reached
   * only if they happen to dial us, and a stash missing from it never holds a copy.
   */
  it('hands native the opted-in stash and every pool member as push targets', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.deliveryMode = 'stash';
    const svc = makeService(stashDeps());

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setDeliveryConfig).toEqual([
      {
        peerTickets: ['ticket-stash', 'ticket-b', 'ticket-c'],
        stashBaseUrl: 'https://stash.test',
        stashPsk: null,
      },
    ]);
  });

  /**
   * With the stash off there is no durable copy anywhere but the pool, so if this regressed to an
   * empty list a friend could only relay a fix it had never been sent — the peer-relay gap
   * `scripts/e2e/relay-e2e.sh` was chasing.
   */
  it('still pushes to the pool when the stash is configured but not opted into', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.deliveryMode = 'mutual';
    const svc = makeService(stashDeps());

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setDeliveryConfig).toEqual([
      { peerTickets: ['ticket-b', 'ticket-c'], stashBaseUrl: null, stashPsk: null },
    ]);
  });

  /**
   * `stashConfig` is build-time env; the opt-in is the user's answer. Gating the content upload on
   * the former would PUT sealed envelopes to the durable server for someone who switched it off —
   * into a namespace `syncStashGrants` never registered, so it would fail on every drain too and
   * bury real push failures in the noise.
   */
  it('gives native no stash upload target when the user has opted out', async () => {
    mockHolder.stashConfig = { baseUrl: 'https://stash.test', ticket: 'ticket-stash', psk: null };
    mockHolder.deliveryMode = 'mutual';
    const svc = makeService(stashDeps());

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    const [config] = mockHolder.mod.calls.setDeliveryConfig;
    expect(config.stashBaseUrl).toBeNull();
    expect(config.peerTickets).not.toContain('ticket-stash');
  });

  /** An empty list is how native knows there is nothing to dial (`NoTargets`), not a skipped call. */
  it('mirrors an empty target list when there is no stash and no pool', async () => {
    mockHolder.pool = { friends: {}, sharingWith: [] };
    const svc = makeService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.calls.setDeliveryConfig).toEqual([
      { peerTickets: [], stashBaseUrl: null, stashPsk: null },
    ]);
  });
});
