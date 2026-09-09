import { ScrollView, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';
import { MapDrawer } from '../map-drawer';

type PanEvent = { translationY: number; velocityY: number };
type TestGesture = {
  start?: () => void;
  update?: (event: PanEvent) => void;
  end?: (event: PanEvent) => void;
};
const mockPans: TestGesture[] = [];

jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    Native: () => ({}),
    Pan: () => {
      const gesture = {
        simultaneousWithExternalGesture: () => gesture,
        onStart: (fn: TestGesture['start']) => {
          gesture.start = fn;
          return gesture;
        },
        onUpdate: (fn: TestGesture['update']) => {
          gesture.update = fn;
          return gesture;
        },
        onEnd: (fn: TestGesture['end']) => {
          gesture.end = fn;
          return gesture;
        },
        start: undefined as TestGesture['start'],
        update: undefined as TestGesture['update'],
        end: undefined as TestGesture['end'],
      };
      mockPans.push(gesture);
      return gesture;
    },
  },
}));
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    interpolate: () => 0,
    runOnJS: (fn: () => void) => fn,
    withSpring: (value: number) => value,
  };
});
jest.mock('../island-tabs', () => ({ IslandTabs: () => null }));
jest.mock('@/global.css', () => ({}));

describe('MapDrawer grip', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(detent: 'collapsed' | 'full') {
    const onDetentChange = jest.fn();
    act(() => {
      renderer = create(
        <MapDrawer
          activeTab="friends"
          detent={detent}
          minDetent="collapsed"
          maxDetent="full"
          insetBottom={34}
          insetTop={59}
          screenHeight={844}
          signal="#2f9e6a"
          theme={CryptidThemes.daybreak}
          onDetentChange={onDetentChange}
          onSelectTab={jest.fn()}
        >
          <Text>Roster</Text>
        </MapDrawer>
      );
    });
    return onDetentChange;
  }

  it('lets the grip collapse fully even when the list has scrolled', () => {
    const onDetentChange = render('full');
    act(() => {
      renderer.root.findByType(ScrollView).props.onScroll({
        nativeEvent: { contentOffset: { y: 200 } },
      });
      const grip = mockPans[mockPans.length - 2];
      grip.start?.();
      grip.update?.({ translationY: 700, velocityY: 0 });
      grip.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('collapsed');
  });

  it('leaves body drags to a scrolled list', () => {
    const onDetentChange = render('full');
    act(() => {
      renderer.root.findByType(ScrollView).props.onScroll({
        nativeEvent: { contentOffset: { y: 200 } },
      });
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 700, velocityY: 0 });
      body.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('keeps the handle accessible while hiding the collapsed body from VoiceOver', () => {
    const onDetentChange = render('collapsed');
    const grip = renderer.root.findByProps({ accessibilityLabel: 'Panel size' });
    expect(grip.props.accessibilityValue.text).toBe('Minimized');
    expect(renderer.root.findByType(ScrollView).props.accessibilityElementsHidden).toBe(true);
    act(() => grip.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(onDetentChange).toHaveBeenCalledWith('peek');
  });
});
