/**
 * `mod.start()` must not be able to hang the launch.
 *
 * On 2026-09-13 an iPhone 16 Pro Max went dark for 13 h and then froze on the splash screen when
 * it was reopened. The cause was `ble::attach` awaiting a CoreBluetooth radio that never came up,
 * inside `LocationNode::start`, while the process-wide `inner` lock was held — so `start` never
 * returned, and the JS launch awaited it forever. The only trace of any of it was a single
 * `telemetry: OTLP export active` log line per boot: every span the launch would have emitted is
 * downstream of the call that was stuck.
 *
 * The native side now bounds both of its slow awaits, but the guard that matters here is the one
 * that survives a version skew. A phone can be running an older `.so`/XCFramework than the JS
 * bundle — that is exactly the shape of the outage — so the JS bundle carries its own bound and
 * its own span, and these pin both.
 */

import { setTelemetryForTesting } from '@/features/dev/telemetry';
import type { Telemetry } from '@/features/dev/telemetry';

import type { PoolState } from '../../core/pool';

/** Resolves only when the test says so; stands for a native start that is stuck in the radio. */
function pending(): { promise: Promise<void>; settle: () => void } {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

class FakeNativeModule {
  /** When set, `start` returns this instead of resolving immediately. */
  startGate: Promise<void> | null = null;
  startCalls = 0;
  /** How many `start` calls should be refused by the process-wide Rust writer claim. */
  refuseStarts = 0;
  handovers: number[] = [];
  releases = 0;
  /** `false` stands for a binary built before `handOverNativeBackground` existed. */
  supportsHandover = true;
  /** What the bounded native handover reports back. */
  handoverCompletes = true;

  async createNode() {
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  start(): Promise<void> {
    this.startCalls += 1;
    if (this.refuseStarts > 0) {
      this.refuseStarts -= 1;
      // The shape `durable.rs` refuses a second writer with, surfaced across the bridge.
      return Promise.reject(new Error('store already open: AlreadyOpen'));
    }
    return this.startGate ?? Promise.resolve();
  }
  get handOverNativeBackground(): ((timeoutMs: number) => Promise<boolean>) | undefined {
    if (!this.supportsHandover) return undefined;
    return async (timeoutMs: number) => {
      this.handovers.push(timeoutMs);
      return this.handoverCompletes;
    };
  }
  releaseNativeBackground = () => {
    this.releases += 1;
  };
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
  async syncTrail() {}
  async pushTrail() {}
  async readTrail() {
    return [];
  }
  async pruneTrail() {}
  async setSharingRecipients() {}
  addListener() {
    return { remove: () => {} };
  }
}

const mockHolder: { mod: FakeNativeModule; pool: PoolState | null } = {
  mod: new FakeNativeModule(),
  pool: null,
};

jest.mock('iroh-location', () => ({
  getIrohLocation: () => mockHolder.mod,
  tryGetIrohLocation: () => mockHolder.mod,
  getStashConfig: () => null,
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));

jest.mock('../persistence', () => ({
  ...jest.requireActual('../persistence'),
  loadPool: async () => mockHolder.pool,
  savePool: async () => {},
}));

// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

/** Matches `NATIVE_START_TIMEOUT_MS` in `location-sharing.ts`. */
const NATIVE_START_TIMEOUT_MS = 60_000;

const spanNames: string[] = [];
let flushes = 0;

function recordingTelemetry(): void {
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
    enabled: true,
    startSpan: (name: string) => {
      spanNames.push(name);
      return span;
    },
    withSpan: async (_name, _opts, fn) => fn(span),
    log: () => {},
    setResourceAttributes: () => {},
    flush: async () => {
      flushes += 1;
    },
  };
  setTelemetryForTesting(telemetry);
}

beforeEach(() => {
  jest.useFakeTimers();
  spanNames.length = 0;
  flushes = 0;
  recordingTelemetry();
  mockHolder.mod = new FakeNativeModule();
  mockHolder.pool = null;
});

afterEach(() => {
  jest.useRealTimers();
});

afterAll(() => setTelemetryForTesting(undefined));

describe('the launch bounds the native start', () => {
  it('fails the launch instead of awaiting a native start that never returns', async () => {
    const gate = pending();
    mockHolder.mod.startGate = gate.promise;
    const svc = new LocationSharingService();

    const launch = svc.init('@me', 'mothman', '', '', { mode: 'headless' });
    const settled = jest.fn();
    void launch.then(settled, settled);

    // Up to the deadline the launch is still outstanding: the bound must not fire early on a
    // start that is merely slow.
    await jest.advanceTimersByTimeAsync(NATIVE_START_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(2);
    await expect(launch).rejects.toThrow(/native start did not return/);

    gate.settle();
  });

  /**
   * The span is the deliverable, not a side effect. Without it this failure is indistinguishable
   * from a phone that was simply never woken, which is how the original outage stayed unexplained
   * for a day — and it is flushed because a headless wake may be frozen the moment `init` rejects.
   */
  it('emits node.start_timeout and flushes it before giving up', async () => {
    const gate = pending();
    mockHolder.mod.startGate = gate.promise;
    const svc = new LocationSharingService();

    const launch = svc.init('@me', 'mothman', '', '', { mode: 'headless' });
    void launch.catch(() => {});

    await jest.advanceTimersByTimeAsync(NATIVE_START_TIMEOUT_MS + 1);
    await expect(launch).rejects.toThrow();

    expect(spanNames).toContain('node.start_timeout');
    expect(flushes).toBeGreaterThan(0);

    gate.settle();
  });

  it('leaves a healthy launch alone and emits no timeout span', async () => {
    const svc = new LocationSharingService();

    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    expect(mockHolder.mod.startCalls).toBe(1);
    expect(spanNames).not.toContain('node.start_timeout');

    await svc.shutdownAsync();
  });
});

/**
 * Opening the app after a background launch armed the native runtime.
 *
 * The Rust writer claim is process-wide and held by whichever half built a node first. Once a
 * background launch can arm `BackgroundLocationRuntime` with no React at all, that half is
 * routinely the native one — and `createNode`/`start` then throw `AlreadyOpen`, failing `init()`
 * before `setServiceReady(true)`. The app draws its chrome from `hydrateFromStore()` and never
 * finishes: the 2026-09-18 shape, arriving from the other end of the lifecycle.
 *
 * `releaseNativeBackground` cannot fix it. It drops two Swift references and returns, while
 * `Subscription` and the spawned receive task each still hold an `Arc<LocationNode>` — only
 * `shutdown` frees the claims.
 */
describe('the native store-claim handover', () => {
  it('asks the native runtime for the stores before building a node', async () => {
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman', '', '');
    expect(mockHolder.mod.handovers).toHaveLength(1);
    await svc.shutdownAsync();
  });

  it('retries once when the claim is still refused, and then succeeds', async () => {
    mockHolder.mod.refuseStarts = 1;
    const svc = new LocationSharingService();

    await expect(svc.init('@me', 'mothman', '', '')).resolves.not.toThrow();

    expect(mockHolder.mod.startCalls).toBe(2);
    // One handover before `createNode`, one more on the refusal.
    expect(mockHolder.mod.handovers).toHaveLength(2);
    expect(spanNames).toContain('node.start.claim_refused');
    await svc.shutdownAsync();
  });

  /** One retry, not a loop: a loop here is the 2026-09-16 construction storm in a new costume. */
  it('gives up after one retry rather than looping', async () => {
    mockHolder.mod.refuseStarts = 5;
    const svc = new LocationSharingService();

    await expect(svc.init('@me', 'mothman', '', '')).rejects.toThrow(/AlreadyOpen/);

    expect(mockHolder.mod.startCalls).toBe(2);
    await svc.shutdownAsync();
  });

  /** A handover we could not confirm still hands ownership over, so the app must proceed anyway. */
  it('proceeds when the native side reports the shutdown did not complete', async () => {
    mockHolder.mod.handoverCompletes = false;
    const svc = new LocationSharingService();
    await expect(svc.init('@me', 'mothman', '', '')).resolves.not.toThrow();
    await svc.shutdownAsync();
  });

  /**
   * A phone can run a JS bundle newer than its binary. `releaseNativeBackground` is the older,
   * weaker equivalent and the best that binary can do.
   */
  it('falls back to release on a binary without the handover export', async () => {
    mockHolder.mod.supportsHandover = false;
    const svc = new LocationSharingService();

    await svc.init('@me', 'mothman', '', '');

    expect(mockHolder.mod.handovers).toHaveLength(0);
    expect(mockHolder.mod.releases).toBeGreaterThan(0);
    await svc.shutdownAsync();
  });

  /** A headless init never claims anything, so it must not take the stores from a live runtime. */
  it('does not hand over on the headless path', async () => {
    const svc = new LocationSharingService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });
    expect(mockHolder.mod.handovers).toHaveLength(0);
    await svc.shutdownAsync();
  });
});
