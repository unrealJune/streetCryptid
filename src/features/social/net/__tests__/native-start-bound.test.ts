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

  async createNode() {
    return { endpointId: 'aa11', identitySecret: 'ii', recvSecret: 'rr', recvPublic: 'rp' };
  }
  start(): Promise<void> {
    this.startCalls += 1;
    return this.startGate ?? Promise.resolve();
  }
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
