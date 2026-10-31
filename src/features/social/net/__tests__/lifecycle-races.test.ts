/**
 * The service's startup and pairing-poll races, one interleaving per test.
 *
 * The rules are proven exhaustively against the pure machines (`core/__tests__/
 * pairing-poll-driver.test.ts`, `post-ready-steps.test.ts`, `service-lifecycle.test.ts`). These
 * prove the service actually routes through them: each holds a native call at the moment the race
 * needs, does the other thing, lets it go, and checks what a user would see.
 */
import type { PairEvent, PairStateRecord, ProfileView } from 'iroh-location';

import {
  createTelemetry,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';

import * as pool from '../../core/pool';
import type { Friend } from '../../core/types';
import { FakeNativeModule } from '../__fixtures__/fake-pairing-module';

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

// eslint-disable-next-line import/first
import { LocationSharingService, type SharingSnapshot } from '../location-sharing';
// eslint-disable-next-line import/first
import * as persistence from '../persistence';

const running: LocationSharingService[] = [];

function makeService(): LocationSharingService {
  const svc = new LocationSharingService();
  running.push(svc);
  return svc;
}

/** The private surface these tests drive: the lifecycle handlers and the poll driver's state. */
type Internals = {
  onEnterBackground(): void;
  onEnterForeground(): void;
  rebindNode(trigger: string): Promise<void>;
  pairingPoll: { current: { timer: number | null; gate: { stopped: boolean } } };
};
const internals = (svc: LocationSharingService) => svc as unknown as Internals;

function watch(svc: LocationSharingService): { current: SharingSnapshot | null } {
  const holder: { current: SharingSnapshot | null } = { current: null };
  svc.onChange((snapshot) => {
    holder.current = snapshot;
  });
  return holder;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function settleMany(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await settle();
}

/** Spans by name, from a collector the test owns. */
function captureSpans() {
  const sent: string[] = [];
  const attributes: Record<string, unknown>[] = [];
  const telemetry = createTelemetry({
    endpoint: 'http://collector.test',
    transport: async (_url, body) => {
      const payload = JSON.parse(body) as {
        resourceSpans?: {
          scopeSpans?: {
            spans?: { name: string; attributes: { key: string; value: object }[] }[];
          }[];
        }[];
      };
      for (const span of payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans ?? []) {
        sent.push(span.name);
        attributes.push(
          Object.fromEntries(
            span.attributes.map((a) => [a.key, Object.values(a.value)[0] as unknown])
          )
        );
      }
    },
  });
  setTelemetryForTesting(telemetry);
  return {
    async named(name: string): Promise<Record<string, unknown>[]> {
      await telemetry.flush();
      return attributes.filter((_, i) => sent[i] === name);
    },
  };
}

function profile(endpointId: string, epoch: number, handle: string): ProfileView {
  return {
    endpointId,
    epoch,
    handle,
    cryptidName: 'Peer',
    sigil: 'sigil',
    color: '#123456',
    recvPub: 'peerrecv',
    ts: epoch,
  };
}

const friendCard: Friend = {
  endpointId: 'ff00',
  handle: '@friend',
  sigil: 'mothman',
  recvPublic: 'ff-recv',
  ticket: 'ticket-ff',
  docTicket: 'doc-ff',
  profileTicket: 'profile-ff',
};

/** Start with `friendCard` already in the persisted pool, as a relaunch does. */
function seedPool(): void {
  jest
    .spyOn(persistence, 'loadPool')
    .mockResolvedValue(pool.addFriend(pool.emptyPool(), friendCard));
}

function session(id: string): PairStateRecord {
  return {
    sessionId: id,
    peerEndpointId: `peer-${id}`,
    state: 'handshaking',
    localAccepted: false,
    peerAccepted: false,
    initiator: false,
    nearby: false,
    sasVerified: false,
    localSasConfirmed: false,
  } as PairStateRecord;
}

beforeEach(() => {
  mockHolder.mod = new FakeNativeModule();
  setTelemetryForTesting(undefined);
  resetEventLogForTesting();
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
});

describe('post-ready work runs alongside everything else', () => {
  it('keeps a newer profile that lands before the startup read of an older one', async () => {
    seedPool();
    mockHolder.mod.profiles.set('ff00', profile('ff00', 100, '@old'));
    const read = mockHolder.mod.hold('readProfile');
    const svc = makeService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    // The live profile event arrives while the startup read is still out.
    mockHolder.mod.profileEvents = [profile('ff00', 200, '@new')];
    await svc.refreshPairing();
    expect(snap.current?.friends.find((f) => f.endpointId === 'ff00')?.handle).toBe('@new');

    read.release();
    await svc.awaitPostReadyWork();
    const friend = snap.current?.friends.find((f) => f.endpointId === 'ff00');
    expect(friend?.handle).toBe('@new');
    expect(friend?.profileEpoch).toBe(200);
  });

  it('does not bring back a friend removed while the startup read was out', async () => {
    seedPool();
    mockHolder.mod.profiles.set('ff00', profile('ff00', 100, '@old'));
    const read = mockHolder.mod.hold('readProfile');
    const svc = makeService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    await svc.removeFriend('ff00');
    read.release();
    await svc.awaitPostReadyWork();
    await settleMany();

    expect(snap.current?.friends.map((f) => f.endpointId)).toEqual([]);
  });

  it('applies and persists nothing that lands after shutdown, and says what it abandoned', async () => {
    const spans = captureSpans();
    seedPool();
    mockHolder.mod.profiles.set('ff00', profile('ff00', 300, '@late'));
    const read = mockHolder.mod.hold('readProfile');
    const sessions = mockHolder.mod.hold('listPairSessions');
    // A completed pair sitting in the queue: if the poll's results were applied after shutdown,
    // its `ready` would be handled and a result requested.
    mockHolder.mod.pairEvents = [
      { kind: 'ready', sessionId: 's1', peerEndpointId: 'p1', nearby: false } as PairEvent,
    ];
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await settleMany();
    const save = jest.spyOn(persistence, 'savePool');

    const shutdown = svc.shutdownAsync();
    read.release();
    sessions.release();
    await shutdown;
    await settleMany();

    expect(save).not.toHaveBeenCalled();
    expect(mockHolder.mod.calls.pairResult).toEqual([]);
    const steps = await spans.named('app.init.step');
    expect(steps.map((s) => `${String(s['init.step'])}:${String(s.outcome)}`).sort()).toEqual([
      'pairing-poll:abandoned',
      'profiles:abandoned',
      'stash-grant:ok',
    ]);
  });

  it('applies nothing from a poll that was mid-apply when the service shut down', async () => {
    seedPool();
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.awaitPostReadyWork();
    // The next poll reads a newer profile, then waits on the BLE reads before applying it.
    const diagnostics = mockHolder.mod.hold('nearbyBlePeers');
    mockHolder.mod.profileEvents = [profile('ff00', 500, '@after-shutdown')];
    void svc.refreshPairing();
    await settleMany();
    const save = jest.spyOn(persistence, 'savePool');

    const shutdown = svc.shutdownAsync();
    diagnostics.release();
    await shutdown;
    await settleMany();

    expect(save).not.toHaveBeenCalled();
  });
});

describe('the pairing poll', () => {
  /** Rule 3: a caller is never answered by a poll older than its question. */
  it('answers a refresh made during the first poll with a fresh poll', async () => {
    const sessions = mockHolder.mod.hold('listPairSessions');
    const svc = makeService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');

    mockHolder.mod.sessions = [session('fresh')];
    let answered = false;
    const refresh = svc.refreshPairing().then(() => {
      answered = true;
    });
    sessions.release();
    await refresh;

    expect(answered).toBe(true);
    expect(snap.current?.pairing.sessions.map((s) => s.sessionId)).toEqual(['fresh']);
    expect(mockHolder.mod.calls.listPairSessions).toBe(2);
  });

  /** The rule that would have kept pairing alive on the 2026-10-13 Pixel. */
  it('releases a poll that hangs, says so once, and keeps pairing working', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const spans = captureSpans();
    const hung = mockHolder.mod.hold('listPairSessions');
    const svc = makeService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await settleMany();
    // The first poll's native call never returns; later ones do.
    hung.detach();

    // A refresh made now would once have been handed the hung poll, forever. It waits for a poll
    // that starts after it — which the stall makes possible.
    mockHolder.mod.sessions = [session('after')];
    let answered = false;
    const waiting = svc.refreshPairing().then(() => {
      answered = true;
    });
    await jest.advanceTimersByTimeAsync(19_999);
    expect(answered).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await waiting;
    expect(snap.current?.pairing.sessions.map((s) => s.sessionId)).toEqual(['after']);
    expect(await spans.named('pairing.poll.stalled')).toHaveLength(1);

    // And pairing keeps working afterwards.
    mockHolder.mod.sessions = [session('later')];
    await svc.refreshPairing();
    expect(snap.current?.pairing.sessions.map((s) => s.sessionId)).toEqual(['later']);
    expect(await spans.named('pairing.poll.stalled')).toHaveLength(1);
  });

  it('handles a stalled poll that lands late without overwriting what a newer one read', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const spans = captureSpans();
    mockHolder.mod.sessions = [session('old')];
    const hung = mockHolder.mod.hold('listPairSessions');
    const svc = makeService();
    const snap = watch(svc);
    await svc.init('@me', 'mothman');
    await settleMany();
    await jest.advanceTimersByTimeAsync(20_000);

    hung.detach();
    mockHolder.mod.sessions = [session('new')];
    await svc.refreshPairing();
    expect(snap.current?.pairing.sessions.map((s) => s.sessionId)).toEqual(['new']);

    hung.release();
    await settleMany();
    expect(snap.current?.pairing.sessions.map((s) => s.sessionId)).toEqual(['new']);
    expect(await spans.named('pairing.poll.late')).toHaveLength(1);
  });

  it('does not poll before ready, whatever comes to the foreground during init', async () => {
    const start = mockHolder.mod.hold('start');
    const svc = makeService();
    const init = svc.init('@me', 'mothman');
    await settleMany();
    internals(svc).onEnterBackground();
    internals(svc).onEnterForeground();
    await svc.refreshPairing();
    await settleMany();
    expect(mockHolder.mod.calls.pollPairEvents).toBe(0);

    start.release();
    await init;
    await svc.awaitPostReadyWork();
    expect(mockHolder.mod.calls.pollPairEvents).toBeGreaterThan(0);
  });

  it('starts nothing for an init that lands after shutdown', async () => {
    const spans = captureSpans();
    const start = mockHolder.mod.hold('start');
    const svc = makeService();
    const init = svc.init('@me', 'mothman').catch(() => undefined);
    await settleMany();
    const shutdown = svc.shutdownAsync();
    start.release();
    await Promise.all([init, shutdown]);
    await settleMany();

    expect(mockHolder.mod.calls.pollPairEvents).toBe(0);
    expect(internals(svc).pairingPoll.current.timer).toBeNull();
    expect(await spans.named('app.init.step')).toEqual([]);
  });

  it('does not re-arm in the background after a poll lands, and resumes on return', async () => {
    const sessions = mockHolder.mod.hold('listPairSessions');
    const svc = makeService();
    await svc.init('@me', 'mothman');
    internals(svc).onEnterBackground();
    sessions.release();
    await svc.awaitPostReadyWork();
    await settleMany();
    expect(internals(svc).pairingPoll.current.timer).toBeNull();
    const before = mockHolder.mod.calls.pollPairEvents;

    internals(svc).onEnterForeground();
    await settleMany();
    expect(mockHolder.mod.calls.pollPairEvents).toBe(before + 1);
    expect(internals(svc).pairingPoll.current.timer).not.toBeNull();
  });

  it('starts no poll against a node being rebuilt', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman');
    await svc.awaitPostReadyWork();
    const start = mockHolder.mod.hold('start');
    const rebind = internals(svc).rebindNode('test');
    await settleMany();
    const before = mockHolder.mod.calls.pollPairEvents;

    await svc.refreshPairing();
    await settleMany();
    expect(mockHolder.mod.calls.pollPairEvents).toBe(before);

    start.release();
    await rebind;
    expect(mockHolder.mod.calls.pollPairEvents).toBeGreaterThan(before);
  });
});
