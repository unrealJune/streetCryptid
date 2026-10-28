/**
 * `healIfIsolated`: a mounted app rebuilds its node through `rebindNode` when the native core says
 * the phone has reached nobody for long enough (`modules/iroh-location/rust/src/isolation.rs`), and
 * does nothing otherwise. The policy itself — when a rebuild is due — is the core's and is tested
 * there; this proves the app acts on it, and only on it.
 */
import type { IsolationStatus } from 'iroh-location';

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

function status(overrides: Partial<IsolationStatus> = {}): IsolationStatus {
  return {
    isolated: true,
    isolatedSinceMs: 1,
    silentPasses: 4,
    networkChanges: 1,
    rebuilds: 0,
    rebuildDue: false,
    episodes: 1,
    recoveries: 0,
    ...overrides,
  };
}

async function readyService(isolation?: () => IsolationStatus | null) {
  if (isolation) {
    Object.assign(mockHolder.mod, { isolationStatus: isolation });
  }
  const svc = new LocationSharingService();
  running.push(svc);
  await svc.init('@me', 'mothman');
  await svc.awaitPostReadyWork();
  return svc;
}

beforeEach(() => {
  mockHolder.mod = new FakeNativeModule();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((svc) => svc.shutdownAsync()));
});

describe('healIfIsolated', () => {
  it('does nothing on a binary without the export', async () => {
    const svc = await readyService();
    const builds = mockHolder.mod.calls.createNode;
    expect(await svc.healIfIsolated()).toBe(false);
    expect(mockHolder.mod.calls.createNode).toBe(builds);
  });

  it('does nothing while the core says no rebuild is due, isolated or not', async () => {
    const svc = await readyService(() => status({ rebuildDue: false }));
    const builds = mockHolder.mod.calls.createNode;
    expect(await svc.healIfIsolated()).toBe(false);
    expect(mockHolder.mod.calls.createNode).toBe(builds);
  });

  it('rebinds the node when a rebuild is due', async () => {
    const svc = await readyService(() => status({ rebuildDue: true }));
    const builds = mockHolder.mod.calls.createNode;
    expect(await svc.healIfIsolated()).toBe(true);
    expect(mockHolder.mod.calls.createNode).toBe(builds + 1);
  });

  it('treats a throwing export as nothing to do', async () => {
    const svc = await readyService(() => {
      throw new Error('native binding missing');
    });
    expect(await svc.healIfIsolated()).toBe(false);
  });
});
