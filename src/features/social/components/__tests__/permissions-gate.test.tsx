import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { InMemoryKV } from '@/features/social/net/background/persistent-kv';
import {
  loadLocationDisclosureChoice,
  loadPermissionsAsked,
  saveLocationDisclosureChoice,
} from '@/features/social/net/persistence';

import type { PermissionContext, PermissionStepId } from '../../core/permission-steps';
import { PermissionJourneyScreen } from '../../screens/permissions-journey-screen';
import { PermissionSteps, PermissionsGate } from '../permissions-gate';

jest.mock('@/global.css', () => ({}));
jest.mock('../../screens/permissions-journey-screen', () => ({
  PermissionJourneyScreen: () => null,
}));
jest.mock('@/features/dev/telemetry', () => ({
  getTelemetry: () => ({ startSpan: () => ({ end: () => undefined }) }),
}));

let mockKV = new InMemoryKV();
jest.mock('@/features/social/net/persistence', () => ({
  ...jest.requireActual('@/features/social/net/persistence'),
  createPersistentKV: () => mockKV,
}));

let mockFacts: Pick<PermissionContext, 'platform' | 'androidApi' | 'native' | 'granted'>;
const mockRequest = jest.fn<Promise<boolean | undefined>, [PermissionStepId]>();
jest.mock('../../net/permission-requests', () => ({
  readPermissionFacts: () => Promise.resolve(mockFacts),
  requestPermissionStep: (step: PermissionStepId) => mockRequest(step),
}));

const NATIVE = { bluetooth: true, localNetwork: true, battery: true };

describe('PermissionsGate', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockKV = new InMemoryKV();
    mockFacts = { platform: 'android', androidApi: 37, native: NATIVE, granted: {} };
    mockRequest.mockResolvedValue(true);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  async function render() {
    await act(async () => {
      renderer = create(
        <PermissionsGate>
          <Text>app</Text>
        </PermissionsGate>
      );
    });
  }

  const app = () => renderer.root.findAllByType(Text).length > 0;
  const page = () => renderer.root.findByType(PermissionJourneyScreen).props;
  const asking = () => renderer.root.findAllByType(PermissionJourneyScreen).length > 0;
  const current = () => page().rows.find((row: { state: string }) => row.state === 'current').step;
  const states = () =>
    page().rows.map((row: { step: string; state: string; outcome?: string }) =>
      [row.step, row.state, row.outcome].filter(Boolean).join(' ')
    );

  async function choose(allow: boolean) {
    await act(async () => page().onChoice(allow));
  }

  it('walks a fresh install down one page, one prompt per row, then opens the app', async () => {
    await render();
    expect(states()).toEqual([
      'location current',
      'background-location upcoming',
      'bluetooth upcoming',
      'local-network upcoming',
      'notifications upcoming',
      'battery upcoming',
    ]);

    const seen: string[] = [];
    while (!app()) {
      seen.push(current());
      await choose(true);
      if (asking()) expect(states()).toContain(`${seen[seen.length - 1]} done allowed`);
    }
    expect(seen).toEqual([
      'location',
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
    expect(mockRequest.mock.calls.map(([id]) => id)).toEqual([
      'location',
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
    expect(await loadLocationDisclosureChoice(mockKV)).toBe('accepted');
    expect([...((await loadPermissionsAsked(mockKV)) ?? [])]).toHaveLength(6);
  });

  it('drops what sharing needs after "Not now" on location, without prompting', async () => {
    await render();
    await choose(false);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(await loadLocationDisclosureChoice(mockKV)).toBe('declined');
    expect(states()).toEqual([
      'location done declined',
      'background-location skipped',
      'bluetooth current',
      'local-network upcoming',
      'notifications skipped',
      'battery skipped',
    ]);
  });

  it('opens straight on the battery step for an install that onboarded before the steps', async () => {
    await saveLocationDisclosureChoice(mockKV, 'accepted');
    mockFacts = { ...mockFacts, androidApi: 34, granted: { location: true } };
    await render();
    expect(states()).toEqual(['battery current']);
    await choose(false);
    expect(app()).toBe(true);
    // The answer created the record; the next launch must not read it as an install never asked.
    act(() => renderer.unmount());
    await render();
    expect(app()).toBe(true);
  });

  it('opens the app when there is nothing to ask', async () => {
    await saveLocationDisclosureChoice(mockKV, 'declined');
    mockFacts = { ...mockFacts, platform: 'ios', androidApi: 0 };
    await render();
    expect(app()).toBe(true);
  });

  it('replays every step on an onboarded phone, granted ones included, then calls onDone', async () => {
    await saveLocationDisclosureChoice(mockKV, 'accepted');
    mockFacts = {
      ...mockFacts,
      granted: {
        location: true,
        'background-location': true,
        bluetooth: true,
        'local-network': true,
        notifications: true,
        battery: true,
      },
    };
    const onDone = jest.fn();
    const saveLocationChoice = jest.fn(() => Promise.resolve());
    await act(async () => {
      renderer = create(
        <PermissionSteps replay onDone={onDone} saveLocationChoice={saveLocationChoice} />
      );
    });
    const seen: string[] = [];
    while (asking()) {
      seen.push(current());
      await choose(true);
    }
    expect(seen).toEqual([
      'location',
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
    expect(saveLocationChoice).toHaveBeenCalledWith(true);
    expect(onDone).toHaveBeenCalled();
  });
});
