/**
 * "The user switched sharing off" and "this process is going away" are different instructions, and
 * only one of them may disarm anything.
 *
 * `teardownBackground` has always known that — it deliberately preserves `sc.social.sharingEnabled`
 * and the revive fence, because a shutdown that erased them left sharing off until someone opened
 * the app. It then routed the native call through the same `stopNativeBackground` the user-off path
 * uses, which on iOS unmonitors SLC, clears the stop-anchor fence and un-persists the anchor: every
 * mechanism that can relaunch a terminated app, removed by a teardown that was explicitly trying not
 * to remove things.
 *
 * It has not been firing — `performShutdown` nulls `this.mod` before it gets there, so the call is a
 * silent no-op on the one path that reaches it with sharing still on. That is an accident of
 * ordering rather than a design, and these pin the intent so moving that line back cannot quietly
 * reintroduce a day of silence.
 */

import { setTelemetryForTesting } from '@/features/dev/telemetry';
import type { Telemetry } from '@/features/dev/telemetry';

import type { PoolState } from '../../core/pool';

class FakeNativeModule {
  calls = { start: 0, stop: 0, release: 0 };
  /** `false` stands for a binary built before `releaseNativeBackground` existed. */
  supportsRelease = true;

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

  startNativeBackground = () => {
    this.calls.start += 1;
  };
  stopNativeBackground = () => {
    this.calls.stop += 1;
  };
  // A getter, so `typeof mod.releaseNativeBackground === 'function'` is false on the old-binary
  // case exactly as it would be for a missing native export.
  get releaseNativeBackground(): (() => void) | undefined {
    if (!this.supportsRelease) return undefined;
    return () => {
      this.calls.release += 1;
    };
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

const running: LocationSharingService[] = [];

function makeService(): LocationSharingService {
  const svc = new LocationSharingService();
  running.push(svc);
  return svc;
}

function silentTelemetry(): void {
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
    log: () => {},
    setResourceAttributes: () => {},
    flush: async () => {},
  };
  setTelemetryForTesting(telemetry);
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
});
afterAll(() => setTelemetryForTesting(undefined));

describe('native background: stop versus release', () => {
  beforeEach(() => {
    silentTelemetry();
    mockHolder.mod = new FakeNativeModule();
    mockHolder.pool = null;
  });

  /**
   * The invariant that matters. It passes on today's code too — `this.mod` is already null by the
   * time the teardown reaches the native call — but that is the accident, not the guarantee, and
   * this is what fails if the null moves back below the teardown.
   */
  it('never disarms the native runtime on a process shutdown', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.shutdownAsync();

    expect(mockHolder.mod.calls.stop).toBe(0);
  });

  /** The user switching sharing off is the one instruction that SHOULD take the ladder down. */
  it('does disarm it when the user switches sharing off', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.stopBackground();

    expect(mockHolder.mod.calls.stop).toBeGreaterThan(0);
  });

  /**
   * `stopBackground` disarms once, itself, and then runs the same teardown every shutdown runs —
   * which must take the release path. A second stop from in there would be harmless today and wrong
   * in principle: the teardown does not know why it is running.
   */
  it('routes the teardown inside a stop through release, not a second stop', async () => {
    const svc = makeService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.stopBackground();

    expect(mockHolder.mod.calls.stop).toBe(1);
    expect(mockHolder.mod.calls.release).toBe(1);
  });

  /**
   * A phone can run a JS bundle newer than its binary, so the export can be missing. Falling back to
   * the full stop is the deliberate choice: on Android a foreground service left running with no JS
   * to reach it is worse than a disarmed one, and on iOS it is what that binary has always done.
   */
  it('falls back to the full stop on a binary without the release export', async () => {
    mockHolder.mod.supportsRelease = false;
    const svc = makeService();
    await svc.init('@me', 'mothman', '', '', { mode: 'headless' });

    await svc.stopBackground();

    expect(mockHolder.mod.calls.release).toBe(0);
    expect(mockHolder.mod.calls.stop).toBe(2);
  });
});
