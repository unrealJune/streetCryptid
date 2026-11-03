/**
 * What a Bump leaves in telemetry. On 2026-10-31 two handshakes were cancelled by the phone that
 * started them, and nothing said who had closed the window or why the session was ended; it had
 * to be read off `app.lifecycle` timestamps. `bump.stage` and `pair.cancel` say it directly.
 */
import {
  createTelemetry,
  resetEventLogForTesting,
  setTelemetryForTesting,
} from '@/features/dev/telemetry';

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
import { LocationSharingService } from '../location-sharing';

const running: LocationSharingService[] = [];

async function startedService(): Promise<LocationSharingService> {
  const svc = new LocationSharingService();
  running.push(svc);
  await svc.init('@me', 'mothman');
  return svc;
}

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

beforeEach(() => {
  mockHolder.mod = new FakeNativeModule();
  setTelemetryForTesting(undefined);
  resetEventLogForTesting();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
  setTelemetryForTesting(undefined);
});

describe('bump.stage', () => {
  it('records each stage of one window under one window id, and why it closed', async () => {
    const spans = captureSpans();
    const svc = await startedService();
    mockHolder.mod.bumpResolution = {
      status: 'noPeers',
      endpointId: null,
      deviceId: null,
      rssi: null,
      peerCount: 0,
      detail: 'no fresh iroh advertisements',
    };

    await svc.armBump();
    await svc.commitBump();
    await svc.cancelBump('background-grace');

    const stages = await spans.named('bump.stage');
    expect(stages.map((s) => [s['bump.from'], s['bump.to'], s['bump.reason']])).toEqual([
      ['idle', 'armed', 'armed'],
      ['armed', 'searching', 'commit'],
      ['searching', 'waiting', 'noPeers'],
      ['waiting', 'idle', 'background-grace'],
    ]);
    expect(new Set(stages.map((s) => s['bump.window'])).size).toBe(1);
    expect(stages[2]).toMatchObject({
      'bump.resolve_status': 'noPeers',
      // OTLP JSON carries integers as strings.
      'bump.peer_count': '0',
      'bump.detail': 'no fresh iroh advertisements',
    });
    expect(Number(stages[3]['bump.since_arm_ms'])).toBeGreaterThanOrEqual(0);
  });

  it('does not record closing a window that was never open', async () => {
    const spans = captureSpans();
    const svc = await startedService();

    await svc.cancelBump('left-screen');

    expect(await spans.named('bump.stage')).toEqual([]);
  });
});

describe('pair.cancel', () => {
  it('says why this phone ended a handshake it had started', async () => {
    const spans = captureSpans();
    const svc = await startedService();
    mockHolder.mod.bumpResolution = {
      status: 'resolved',
      endpointId: 'peer-left',
      deviceId: 'ble-left',
      rssi: -32,
      peerCount: 1,
      detail: 'resolved',
    };
    let resolveSession!: (sessionId: string) => void;
    mockHolder.mod.initiateNearbyPromise = new Promise((resolve) => {
      resolveSession = resolve;
    });

    await svc.armBump();
    const committing = svc.commitBump();
    await Promise.resolve();
    await Promise.resolve();
    await svc.cancelBump('left-screen');
    await svc.standDownPairing([]);
    resolveSession('sess-left');
    await committing;

    expect(await spans.named('pair.cancel')).toEqual([
      expect.objectContaining({
        'sc.session': 'sess-left',
        reason: 'left-screen-during-handshake',
      }),
    ]);
  });
});
