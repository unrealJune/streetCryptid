/**
 * What a backgrounded phone is allowed to keep doing.
 *
 * `onBackground` was an empty handler whose comment said the OS keep-alive "covers this". It does
 * cover *capture* — but the keep-alive is exactly why nothing else stopped: with
 * `UIBackgroundModes: ["location"]` and `allowsBackgroundLocationUpdates`, iOS does not suspend
 * this process while sharing is on, so a swiped-away app keeps every JS timer it had running
 * indefinitely. On 2026-09-18 that was 414 `pairing.poll` entries in one backgrounded stretch,
 * every one returning `sessions: 0, ble_peers: 0, pairing_ready: false` — a phone polling hard for
 * a handshake that needs two present humans. MetricKit answered with 48s of CPU in a 60s window.
 *
 * These pin the three halves of the correction: the pairing loop stops, it cannot be re-armed
 * behind the lifecycle controller's back, and the things that must NOT stop don't.
 */

import { setTelemetryForTesting } from '@/features/dev/telemetry';
import type { Telemetry } from '@/features/dev/telemetry';

jest.mock('expo-location', () => ({
  PermissionStatus: { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' },
  requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  requestBackgroundPermissionsAsync: async () => ({ status: 'granted' }),
  getBackgroundPermissionsAsync: async () => ({ status: 'granted' }),
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    throw new Error('SQLite is deliberately unavailable in this suite');
  },
}));

class FakeNativeModule {
  /** Every native read a pairing poll makes, counted so a stopped loop is observable. */
  pollPairEventCalls = 0;
  cadenceCalls = 0;

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
  async syncLatest() {}
  async pushTrail() {}
  async readTrail() {
    return [];
  }
  async readLatest() {
    return [];
  }
  async pruneTrail() {}
  async setSharingRecipients() {}
  async setDeliveryConfig() {}
  addListener() {
    return { remove: () => {} };
  }

  // ── The pairing poll's own surface ────────────────────────────────────────────────────────
  async pollPairEvents() {
    this.pollPairEventCalls += 1;
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
    return { available: true, pairingReady: false, scanning: false, advertising: false };
  }
  async bleAvailable() {
    return true;
  }
  async setPairingReady() {}
  async transportDiagnostics() {
    return { peers: [], local: [] };
  }

  // ── Background runtime ────────────────────────────────────────────────────────────────────
  startNativeBackground = () => {};
  stopNativeBackground = () => {};
  releaseNativeBackground = () => {};
  nativeBackgroundRunning = () => true;
  nativeBackgroundAuthorized = () => true;
  setBackgroundCadence = () => {
    this.cadenceCalls += 1;
  };
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

/** Replace `addEventListener` so a state transition can actually be delivered. */
function appStateHarness(AppState: { currentState: string; addEventListener: unknown }) {
  const listeners: ((state: string) => void)[] = [];
  const original = AppState.addEventListener;
  AppState.addEventListener = (_event: string, listener: (state: string) => void) => {
    listeners.push(listener);
    return {
      remove: () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  };
  return {
    go(state: string) {
      AppState.currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
    restore: () => {
      AppState.addEventListener = original;
    },
  };
}

// eslint-disable-next-line import/first
import { AppState } from 'react-native';
// eslint-disable-next-line import/first
import { LocationSharingService } from '../location-sharing';

const running: LocationSharingService[] = [];

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

/** Let every queued microtask and timer callback settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The lifecycle handlers, which `createAppLifecycleController` calls on an `AppState` change. */
type Lifecycle = {
  onEnterBackground(): void;
  onEnterForeground(): void;
  pollPairingOnce(): Promise<void>;
};

function lifecycle(svc: LocationSharingService): Lifecycle {
  return svc as unknown as Lifecycle;
}

describe('pairing polling across the app lifecycle', () => {
  beforeEach(() => {
    silentTelemetry();
    mockHolder.mod = new FakeNativeModule();
    (AppState as unknown as { currentState: string }).currentState = 'active';
    // `setImmediate` stays real: it is how `settle()` drains the microtask queue, and a faked
    // one would simply never fire.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
  });
  afterAll(() => setTelemetryForTesting(undefined));

  /** An interactive `init` ends with `startPairingPolling()`, so the loop is live on return. */
  async function started(): Promise<LocationSharingService> {
    const svc = new LocationSharingService();
    running.push(svc);
    await svc.init('@me', 'mothman', '', '');
    await settle();
    return svc;
  }

  /** Advance past several poll intervals and let each pass resolve. */
  async function pollFor(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 4000) {
      jest.advanceTimersByTime(4000);
      await settle();
    }
  }

  it('stops polling for pairing when the app goes to the background', async () => {
    const svc = await started();
    await pollFor(16_000);
    expect(mockHolder.mod.pollPairEventCalls).toBeGreaterThan(0);

    lifecycle(svc).onEnterBackground();
    await settle();
    const atBackground = mockHolder.mod.pollPairEventCalls;

    await pollFor(60_000);

    expect(mockHolder.mod.pollPairEventCalls).toBe(atBackground);
  });

  /**
   * Re-arming is not enough on its own. The poll also drains `pollProfileEvents` and runs
   * `reconcileCompletedPairs`, so a friend who finished pairing while we were in a pocket is
   * reconciled the moment the app is opened rather than up to four seconds later.
   */
  it('resumes on foreground and closes the gap immediately', async () => {
    const svc = await started();
    lifecycle(svc).onEnterBackground();
    await settle();
    const atBackground = mockHolder.mod.pollPairEventCalls;

    lifecycle(svc).onEnterForeground();
    await settle();

    expect(mockHolder.mod.pollPairEventCalls).toBe(atBackground + 1);

    await pollFor(16_000);
    expect(mockHolder.mod.pollPairEventCalls).toBeGreaterThan(atBackground + 1);
  });

  /**
   * The guard that makes the stop stick. `onPairReady`, `rebindNodeInner` and `armBump` all call
   * `startPairingPolling`, and none of them knows the app is in a pocket — so stopping the loop
   * without also refusing to re-arm it would be undone by the next unrelated event.
   */
  it('cannot be re-armed while backgrounded', async () => {
    const svc = await started();
    lifecycle(svc).onEnterBackground();
    await settle();
    const atBackground = mockHolder.mod.pollPairEventCalls;

    // Exactly what those three call sites do.
    (svc as unknown as { startPairingPolling(): void }).startPairingPolling();
    await settle();
    await pollFor(30_000);

    expect(mockHolder.mod.pollPairEventCalls).toBe(atBackground);
  });

  /** And the suspension lifts — a re-arm after foregrounding works normally. */
  it('arms normally again once foregrounded', async () => {
    const svc = await started();
    lifecycle(svc).onEnterBackground();
    await settle();
    lifecycle(svc).onEnterForeground();
    await settle();
    const resumed = mockHolder.mod.pollPairEventCalls;

    await pollFor(16_000);

    expect(mockHolder.mod.pollPairEventCalls).toBeGreaterThan(resumed);
  });

  /**
   * The Android-regression guard, and the reason the heartbeat timer is deliberately left alone.
   *
   * `BackgroundLocationService.kt` only ever hands off `reason = "movement"` — there is no native
   * heartbeat handoff on Android — so that timer is the ONLY thing filling slots for a parked
   * Android phone while the app is mounted. Stopping it on background would silence every
   * stationary device, which is the exact failure the uniform-cadence rule exists to prevent.
   */
  it('does not touch the heartbeat timer', async () => {
    const svc = await started();
    const before = (svc as unknown as { heartbeatTimer: unknown }).heartbeatTimer;

    lifecycle(svc).onEnterBackground();
    await settle();

    expect((svc as unknown as { heartbeatTimer: unknown }).heartbeatTimer).toBe(before);
  });

  /**
   * The bump loop is left alone for the same reason it was never the problem: it bounds itself
   * against `isBumpActive()` inside a two-minute window a human opened, so it expires on its own.
   */
  it('does not touch the bump loop', async () => {
    const svc = await started();
    const before = (svc as unknown as { bumpTimer: unknown }).bumpTimer;

    lifecycle(svc).onEnterBackground();
    await settle();

    expect((svc as unknown as { bumpTimer: unknown }).bumpTimer).toBe(before);
  });
});
