import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { PERMISSION_STEP_COPY as COPY, PERMISSIONS_PAGE_COPY } from '@/copy/permissions';

import type { PermissionJourneyRow } from '../../core/permission-steps';
import { PermissionJourneyScreen } from '../permissions-journey-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// Animations finish at once, so a closing row unmounts in the same act() as the answer.
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  const fadeIn = { duration: () => fadeIn };
  return {
    __esModule: true,
    default: { View },
    Easing: { bezier: () => (t: number) => t },
    FadeIn: fadeIn,
    interpolate: () => 1,
    useSharedValue: (value: unknown) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    useReducedMotion: () => false,
    withTiming: (to: number, _config: unknown, done?: (finished: boolean) => void) => {
      done?.(true);
      return to;
    },
  };
});

const FIRST: PermissionJourneyRow[] = [
  { step: 'location', state: 'current' },
  { step: 'background-location', state: 'upcoming' },
  { step: 'bluetooth', state: 'upcoming' },
];
const SECOND: PermissionJourneyRow[] = [
  { step: 'location', state: 'done', outcome: 'allowed' },
  { step: 'background-location', state: 'current' },
  { step: 'bluetooth', state: 'upcoming' },
];

describe('PermissionJourneyScreen', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => act(() => renderer?.unmount()));

  const texts = () =>
    renderer.root.findAllByType(Text).map((node) => [node.props.children].flat().join(''));
  const byTestId = (id: string) => renderer.root.findAll((node) => node.props.testID === id);

  function render(rows: PermissionJourneyRow[], platform: 'android' | 'ios' = 'android') {
    const element = (
      <PermissionJourneyScreen rows={rows} platform={platform} busy={false} onChoice={jest.fn()} />
    );
    act(() => {
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  }

  beforeEach(() => {
    renderer = undefined as unknown as ReactTestRenderer;
  });

  it('opens the current row in full, with the rows to come as one line each', () => {
    render(FIRST);
    expect(texts()).toContain(COPY.location.title);
    expect(texts()).toContain(COPY['background-location'].summary);
    expect(texts()).not.toContain(COPY['background-location'].title);
    expect(texts()).toContain(COPY.location.action);
    expect(byTestId('permission-step-location').length).toBeGreaterThan(0);
  });

  it('collapses an answered row to its outcome and opens the next', () => {
    render(FIRST);
    render(SECOND);
    expect(texts()).not.toContain(COPY.location.title);
    expect(texts()).toContain(PERMISSIONS_PAGE_COPY.outcome.allowed);
    expect(texts()).toContain(COPY['background-location'].title);
    expect(texts()).not.toContain(COPY['background-location'].summary);
    expect(byTestId('permission-step-background-location').length).toBeGreaterThan(0);
  });

  it('says Continue with no "Not now" on iOS', () => {
    render(FIRST, 'ios');
    expect(texts()).not.toContain(COPY.location.action);
    expect(byTestId('permission-step-skip')).toHaveLength(0);
  });
});
