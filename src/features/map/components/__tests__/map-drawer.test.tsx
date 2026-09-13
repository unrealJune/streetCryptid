import { ScrollView, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';
import { MapDrawer } from '../map-drawer';

type PanEvent = { translationY: number; velocityY: number };
type TestGesture = {
  start?: () => void;
  update?: (event: PanEvent) => void;
  end?: (event: PanEvent) => void;
  finalize?: () => void;
  isEnabled: boolean;
};
const mockPans: TestGesture[] = [];

jest.mock('react-native-gesture-handler', () => ({
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  Gesture: {
    Native: () => ({}),
    Pan: () => {
      const gesture = {
        enabled: (on: boolean) => {
          gesture.isEnabled = on;
          return gesture;
        },
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
        onFinalize: (fn: TestGesture['finalize']) => {
          gesture.finalize = fn;
          return gesture;
        },
        start: undefined as TestGesture['start'],
        update: undefined as TestGesture['update'],
        end: undefined as TestGesture['end'],
        finalize: undefined as TestGesture['finalize'],
        isEnabled: true,
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

describe('MapDrawer body drags', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(options: {
    detent: 'peek' | 'mid';
    maxDetent: 'peek' | 'mid';
    /** The body's own natural height, as `onLayout` would report it. */
    bodyHeight: number;
  }) {
    const onDetentChange = jest.fn();
    act(() => {
      renderer = create(
        <MapDrawer
          activeTab="friends"
          detent={options.detent}
          minDetent="peek"
          maxDetent={options.maxDetent}
          insetBottom={34}
          insetTop={59}
          screenHeight={844}
          signal="#2f9e6a"
          theme={CryptidThemes.daybreak}
          onDetentChange={onDetentChange}
          onSelectTab={jest.fn()}
        >
          <Text>A friend</Text>
        </MapDrawer>
      );
    });
    act(() => {
      measuredBody().props.onLayout({ nativeEvent: { layout: { height: options.bodyHeight } } });
    });
    return onDetentChange;
  }

  /** The wrapper whose natural height `peek` is derived from — the first laid-out View in the body. */
  function measuredBody() {
    return renderer.root
      .findByType(ScrollView)
      .findAllByType(View)
      .find((node) => typeof node.props.onLayout === 'function')!;
  }

  function dragBodyDown() {
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 400, velocityY: 0 });
      body.end?.({ translationY: 400, velocityY: 0 });
    });
  }

  // The bug this rule exists for: the drawer resized the very ScrollView the finger was reading,
  // so the list overscrolled and a friend's pane swapped to its shorter summary mid-drag.
  it('leaves a downward drag to a body that still has somewhere to scroll', () => {
    const onDetentChange = render({ detent: 'mid', maxDetent: 'mid', bodyHeight: 500 });
    dragBodyDown();
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('still closes on a downward drag when the body has nothing to scroll', () => {
    const onDetentChange = render({ detent: 'mid', maxDetent: 'mid', bodyHeight: 100 });
    dragBodyDown();
    expect(onDetentChange).toHaveBeenCalledWith('peek');
  });

  // The ME panel: one detent, sized to its own body to the pixel. A rubber-band dip there made the
  // ScrollView shorter than its content, so a panel with nothing to scroll scrolled.
  it('does not drag a drawer that has nowhere to go', () => {
    render({ detent: 'peek', maxDetent: 'peek', bodyHeight: 100 });
    expect(mockPans.every((pan) => pan.isEnabled)).toBe(false);
  });

  it('keeps dragging a drawer that does have somewhere to go', () => {
    render({ detent: 'peek', maxDetent: 'mid', bodyHeight: 100 });
    expect(mockPans[mockPans.length - 1].isEnabled).toBe(true);
  });
});
