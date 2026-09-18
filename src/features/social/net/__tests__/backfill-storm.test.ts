import type { ContactCard } from '../../core/types';
import {
  getEventLog,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';

/**
 * Regression tests for the "app freezes after pairing with a friend" storm.
 *
 * Reproduced off a real device's `streetcryptid.events.db`: 956 `fix.received.app` spans landed in a
 * single ~10s window — one friend's entire multi-day trail arriving as docs backfill the moment
 * reconciliation caught up. Three separate amplifiers turned that into an unresponsive app:
 *
 * 1. every one of those fixes fanned out a trail-change notification, and the provider answered
 *    each by re-reading the WHOLE trail out of SQLite and re-rendering the map — O(n²) in the
 *    trail size, on the JS thread, which is why only the (native-driven) map gesture kept working;
 * 2. every `syncTrail` re-read and re-wrote the entire replica from ts 0, and live mode runs one
 *    every 8s — so the cost above was also paid on a timer, forever, for as long as anyone watched;
 * 3. the transport-diagnostics poll compared snapshots with `JSON.stringify`, whose key order is
 *    not stable across UniFFI calls, so it logged a fat "changed" record every 4s in perpetuity
 *    (391 of 410 polls on the device were byte-identical once key-sorted).
 */

class FakeNativeModule {
  readLatestCalls = 0;
  diagnosticsCalls = 0;

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
  async syncLatest() {}
  async pruneTrail() {}

  trailFixes: {
    author: string;
    seq: number;
    fix: { lat: number; lon: number; accuracyM: number; headingDeg: number; ts: number };
  }[] = [];

  /**
   * Models the replica as it is now: ONE overwritten slot per author, so a read returns each
   * author's current fix and nothing behind it. `trailFixes` is still written as a list of
   * historical entries — collapsing it here is what the real namespace does on write.
   */
  async readLatest() {
    this.readLatestCalls += 1;
    const current = new Map<string, (typeof this.trailFixes)[number]>();
    for (const f of this.trailFixes) {
      const held = current.get(f.author);
      const newer =
        !held || f.fix.ts > held.fix.ts || (f.fix.ts === held.fix.ts && f.seq > held.seq);
      if (newer) current.set(f.author, f);
    }
    return [...current.values()];
  }

  /**
   * Returns a structurally identical snapshot every call, but with the object keys emitted in a
   * different order each time — exactly what the real UniFFI record does, and what made the poll
   * believe the transport state had changed on every single tick.
   */
  async transportDiagnostics() {
    this.diagnosticsCalls += 1;
    const flip = this.diagnosticsCalls % 2 === 0;
    const address = flip
      ? { kind: 'relay', address: 'relay:https://example.invalid/', active: null }
      : { active: null, address: 'relay:https://example.invalid/', kind: 'relay' };
    return { peers: [], localAddresses: [address] };
  }

  async pollPairEvents() {
    return [];
  }
  async pollProfileEvents() {
    return [];
  }
  async listPairSessions() {
    return [];
  }
  async nearbyBlePeers() {
    return [];
  }
  async bleCapabilities() {
    return { pairingReady: false, supported: true, advertising: false, scanning: false };
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

const mockHolder: { mod: FakeNativeModule } = { mod: new FakeNativeModule() };

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => null,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('SQLite is deliberately unavailable in this suite');
  },
}));

// eslint-disable-next-line import/first
import { LocationSharingService, TRAIL_CHANGE_COALESCE_MS } from '../location-sharing';

const running: LocationSharingService[] = [];

function makeService(): LocationSharingService {
  const svc = new LocationSharingService();
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
const settle = (): Promise<void> =>
  new Promise((r) => setTimeout(r, TRAIL_CHANGE_COALESCE_MS + 50));

describe('backfill storm', () => {
  beforeEach(() => {
    mockHolder.mod = new FakeNativeModule();
    setTelemetryForTesting(undefined);
  });

  it('coalesces trail-change notifications across a backfill burst', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    let notifications = 0;
    svc.onTrailChange(() => {
      notifications += 1;
    });

    // One friend's whole trail arriving at once, the way docs reconciliation delivers it.
    for (let seq = 1; seq <= 500; seq += 1) {
      mockHolder.mod.emit('onFix', {
        author: 'bb22',
        seq,
        fix: { lat: 47.6, lon: -122.3, accuracyM: 10, headingDeg: 0, ts: 1_000 + seq },
        backfill: true,
      });
    }
    await flush();
    await settle();

    // Before the fix this was 500 — each one re-reading the entire trail out of SQLite and
    // re-rendering the map.
    expect(notifications).toBeLessThanOrEqual(2);
    expect(notifications).toBeGreaterThan(0);
    // A friend's history is deliberately not retained: the burst collapses to their newest fix,
    // which is what the map draws. See trail-store.ts.
    const trail = (await svc.friendLatest()).filter((point) => point.author === 'bb22');
    expect(trail).toHaveLength(1);
    expect(trail[0].seq).toBe(500);
    expect(trail[0].fix.ts).toBe(1_500);
  });

  it('does not re-ingest the entire replica on every sync', async () => {
    const svc = makeService();
    const snapshots: { lastSyncRecovered: number | null }[] = [];
    svc.onChange((snapshot) => snapshots.push(snapshot));
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);

    mockHolder.mod.trailFixes = Array.from({ length: 300 }, (_, i) => ({
      author: 'bb22',
      seq: i + 1,
      fix: { lat: 47.6, lon: -122.3, accuracyM: 10, headingDeg: 0, ts: 1_000 + i },
    }));

    await svc.syncTrail(0);
    // One read for the whole replica, not one per author — and it yields the friend's CURRENT fix
    // only, so the 300 historical entries never cross the bridge at all.
    expect(mockHolder.mod.readLatestCalls).toBe(1);
    expect(snapshots.at(-1)?.lastSyncRecovered).toBe(1);

    await svc.syncTrail(0);

    // The second sync must not re-store what it already has. Live mode fires one every 8 seconds,
    // and re-ingesting on each is what pinned the JS thread. The watermark is what skips it.
    expect(mockHolder.mod.readLatestCalls).toBe(2);
    expect(snapshots.at(-1)?.lastSyncRecovered).toBe(0);
  });

  it('re-reads a friend from scratch after their cached trail is dropped', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.addFriend(friend);
    mockHolder.mod.trailFixes = [
      { author: 'bb22', seq: 1, fix: { lat: 1, lon: 2, accuracyM: 3, headingDeg: 0, ts: 500 } },
    ];

    await svc.syncTrail(0);
    expect((await svc.friendLatest()).filter((p) => p.author === 'bb22')).toHaveLength(1);

    await svc.removeFriend('bb22');
    expect((await svc.friendLatest()).filter((p) => p.author === 'bb22')).toHaveLength(0);

    await svc.addFriend(friend);
    await svc.syncTrail(0);

    // Removing a friend deletes their cached fix, so the watermark has to reset with them —
    // otherwise the re-read is skipped as "already seen" and they never reappear on the map.
    const restored = (await svc.friendLatest()).filter((p) => p.author === 'bb22');
    expect(restored).toHaveLength(1);
    expect(restored[0].fix.ts).toBe(500);
  });

  it('treats a key-reordered transport snapshot as unchanged', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');

    await svc.refreshTransportDiagnostics();
    await svc.refreshTransportDiagnostics();
    await svc.refreshTransportDiagnostics();
    await svc.refreshTransportDiagnostics();

    expect(mockHolder.mod.diagnosticsCalls).toBeGreaterThanOrEqual(4);
    // Every snapshot above is structurally identical — only the key order differs — so exactly one
    // "changed" record may be written (the first, from null).
    expect(svc.transportDiagnosticsChangeCountForTesting).toBe(1);
  });

  /**
   * What an unchanged poll is allowed to cost.
   *
   * `recordEventLog` persists every level unconditionally — there is no level filter anywhere in
   * the write path — so an unchanged `debug` row still costs a SQLite write, and this one carried
   * every peer and local address, v4 and v6, at ~1.5 KB a tick. On a backgrounded phone that was
   * 568 KB of journal writes in a single six-hour window, describing a transport that had not
   * moved. The count is worth keeping; the payload is not.
   */
  describe('transport poll payload', () => {
    function transportRows() {
      return getEventLog().filter(
        (entry) => entry.action === 'transport.poll' || entry.action === 'transport.status.changed'
      );
    }

    beforeEach(() => resetEventLogForTesting());

    it('writes nothing for an unchanged poll', async () => {
      const svc = makeService();
      // `init` polls once itself, and that first poll is the one real change (from null).
      await svc.init('@me', 'mothman');
      const afterInit = transportRows().length;

      await svc.refreshTransportDiagnostics();
      await svc.refreshTransportDiagnostics();
      await svc.refreshTransportDiagnostics();

      expect(afterInit).toBe(1);
      expect(transportRows()).toHaveLength(1);
    });

    /**
     * A long quiet run must still leave a trace, or a loop that DIED is indistinguishable from a
     * transport that simply held still — the same reason `device.health` is emitted at all.
     */
    it('writes one rollup carrying how many polls it stands for', async () => {
      const svc = makeService();
      await svc.init('@me', 'mothman');

      // One changed poll, then enough unchanged ones to cross the rollup threshold.
      for (let i = 0; i < 61; i += 1) await svc.refreshTransportDiagnostics();

      // Two rows for sixty-one polls: the one real change, and one rollup standing for the rest.
      const rows = transportRows();
      expect(rows).toHaveLength(2);
      const rollup = rows.find((row) => row.action === 'transport.poll');
      expect(rollup).toBeDefined();
      expect(rollup?.details).toMatchObject({ polls_since_change: 60, changed: false });
      // The expensive half is exactly what the rollup leaves out.
      expect((rollup?.details as Record<string, unknown>).diagnostics).toBeUndefined();
    });

    it('carries short peer ids and no previous snapshot on a changed poll', async () => {
      const svc = makeService();
      await svc.init('@me', 'mothman');
      await svc.addFriend(friend);

      await svc.refreshTransportDiagnostics();

      const row = transportRows().find((entry) => entry.action === 'transport.status.changed');
      expect(row).toBeDefined();
      const details = row?.details as Record<string, unknown>;
      // `sc.author`'s 10 characters, not the full 64-char hex, per friend, per tick.
      for (const id of details.requested_peers as string[])
        expect(id.length).toBeLessThanOrEqual(10);
      // Recoverable from the prior row, which by construction exists whenever this one says so.
      expect(details.previous).toBeUndefined();
      expect(details.diagnostics).toBeDefined();
    });
  });
});
