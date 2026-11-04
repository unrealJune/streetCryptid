import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { InMemoryKV } from '@/features/social/net/background/persistent-kv';
import {
  loadLocationDisclosureChoice,
  loadPermissionsAsked,
  saveLocationDisclosureChoice,
} from '@/features/social/net/persistence';

import type { PermissionContext, PermissionStepId } from '../../core/permission-steps';
import { PermissionIntroScreen, PermissionStepScreen } from '../../screens/permission-step-screen';
import { PermissionSteps, PermissionsGate } from '../permissions-gate';

jest.mock('@/global.css', () => ({}));
jest.mock('../../screens/permission-step-screen', () => ({
  PermissionIntroScreen: () => null,
  PermissionStepScreen: () => null,
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
  const step = () => renderer.root.findByType(PermissionStepScreen).props;

  async function choose(allow: boolean) {
    await act(async () => step().onChoice(allow));
  }

  it('walks a fresh install through every step, one prompt each, then opens the app', async () => {
    await render();
    const intro = renderer.root.findByType(PermissionIntroScreen).props;
    expect(intro.steps).toEqual([
      'location',
      'background-location',
      'bluetooth',
      'local-network',
      'notifications',
      'battery',
    ]);
    act(() => intro.onContinue());

    const seen: string[] = [];
    while (!app()) {
      const { step: id, position } = step();
      seen.push(`${id} ${position.join('/')}`);
      await choose(true);
    }
    expect(seen).toEqual([
      'location 1/6',
      'background-location 2/6',
      'bluetooth 3/6',
      'local-network 4/6',
      'notifications 5/6',
      'battery 6/6',
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
    act(() => renderer.root.findByType(PermissionIntroScreen).props.onContinue());
    await choose(false);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(await loadLocationDisclosureChoice(mockKV)).toBe('declined');
    expect(step().step).toBe('bluetooth');
    expect(step().position).toEqual([2, 3]);
  });

  it('opens straight on the battery step for an install that onboarded before the steps', async () => {
    await saveLocationDisclosureChoice(mockKV, 'accepted');
    mockFacts = { ...mockFacts, androidApi: 34, granted: { location: true } };
    await render();
    expect(renderer.root.findAllByType(PermissionIntroScreen)).toHaveLength(0);
    expect(step().step).toBe('battery');
    expect(step().position).toBeNull();
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
    act(() => renderer.root.findByType(PermissionIntroScreen).props.onContinue());
    const seen: string[] = [];
    while (renderer.root.findAllByType(PermissionStepScreen).length > 0) {
      seen.push(step().step);
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
