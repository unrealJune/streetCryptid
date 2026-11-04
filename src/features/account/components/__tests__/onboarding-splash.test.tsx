import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { OnboardingSplash } from '../onboarding-splash';

jest.mock('@/global.css', () => ({}));
// The Skia half is a separate module (and lazily loaded on web); this pins the screen around it.
jest.mock('../splash-canvas-loader', () => ({ SplashCanvas: () => null }));
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (value: number) => {
      const shared = useRef({
        value,
        set(next: number) {
          shared.value = next;
        },
      }).current;
      return shared;
    },
    useAnimatedStyle: (factory: () => object) => factory(),
    useFrameCallback: () => ({ setActive: () => undefined }),
    useReducedMotion: () => false,
  };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn() }) }));
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

describe('OnboardingSplash', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => act(() => renderer?.unmount()));

  function render(onContinue = jest.fn()) {
    act(() => {
      renderer = create(<OnboardingSplash onContinue={onContinue} />);
    });
    return onContinue;
  }

  /** Each pressable carrying the continue testID, once (its host views repeat the props). */
  function continueButtons() {
    const nodes = renderer.root.findAll(
      (node) =>
        node.props.testID === 'onboarding-splash-continue' &&
        typeof node.props.onPress === 'function'
    );
    return nodes.filter(
      (node, index) =>
        nodes.findIndex((other) => other.props.onPress === node.props.onPress) === index
    );
  }

  it('says what the app is and starts setup from the island', () => {
    mockInsets = { top: 47, bottom: 34, left: 0, right: 0 };
    const onContinue = render();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Find your people out in the city.');
    expect(text).toContain('We promise to never save, sell, or snoop on your trail.');

    const [button] = continueButtons();
    expect(button.props.accessibilityLabel).toBe('Get started');
    act(() => button.props.onPress());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('moves the action into the system rail beside one, leaving the island only the words', () => {
    mockInsets = { top: 0, bottom: 20, left: 0, right: 84 };
    const onContinue = render();
    const buttons = continueButtons();
    // One action, in the rail: not a second copy in the island.
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.accessibilityLabel).toBe('Get started');
    act(() => buttons[0].props.onPress());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});
