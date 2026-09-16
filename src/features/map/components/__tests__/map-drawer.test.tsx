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

/** The wrapper whose natural height `peek` is derived from — the laid-out View inside the body. */
function measuredBody(renderer: ReactTestRenderer) {
  return renderer.root
    .findByType(ScrollView)
    .findAllByType(View)
    .find((node) => typeof node.props.onLayout === 'function')!;
}

describe('MapDrawer grip', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(detent: 'collapsed' | 'full', bodyHeight?: number) {
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
    if (bodyHeight !== undefined) {
      act(() => {
        measuredBody(renderer).props.onLayout({ nativeEvent: { layout: { height: bodyHeight } } });
      });
    }
    return onDetentChange;
  }

  // A roster taller than the screen owns every drag on its own rows, so the grip is the only way
  // back down. It must therefore ignore the rule the body follows.
  it('lets the grip collapse fully even from a list that owns its own drags', () => {
    const onDetentChange = render('full', 900);
    act(() => {
      const grip = mockPans[mockPans.length - 2];
      grip.start?.();
      grip.update?.({ translationY: 700, velocityY: 0 });
      grip.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('collapsed');
  });

  it('leaves body drags to a list with somewhere to scroll', () => {
    const onDetentChange = render('full', 900);
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 700, velocityY: 0 });
      body.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('will not scroll a body that fits the detent it is in', () => {
    render('full', 100);
    expect(renderer.root.findByType(ScrollView).props.scrollEnabled).toBe(false);
  });

  it('scrolls a body that does not fit', () => {
    render('full', 900);
    expect(renderer.root.findByType(ScrollView).props.scrollEnabled).toBe(true);
  });

  it('keeps the handle — and the collapsed summary — readable by VoiceOver', () => {
    const onDetentChange = render('collapsed');
    const grip = renderer.root.findByProps({ accessibilityLabel: 'Panel size' });
    expect(grip.props.accessibilityValue.text).toBe('Minimized');
    // The collapsed body is a one-line summary now rather than a clipped nothing, so hiding it
    // would take the one fact the panel is still showing away from a screen reader.
    expect(renderer.root.findByType(ScrollView).props.accessibilityElementsHidden).toBeUndefined();
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
      measuredBody(renderer).props.onLayout({
        nativeEvent: { layout: { height: options.bodyHeight } },
      });
    });
    return onDetentChange;
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

describe('MapDrawer — the allowed range moving under a resting drawer', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(minDetent: 'collapsed' | 'peek', onDetentChange: jest.Mock) {
    act(() => {
      renderer = create(
        <MapDrawer
          activeTab="me"
          detent="collapsed"
          minDetent={minDetent}
          maxDetent="peek"
          insetBottom={34}
          insetTop={59}
          screenHeight={844}
          signal="#2f9e6a"
          theme={CryptidThemes.daybreak}
          onDetentChange={onDetentChange}
          onSelectTab={jest.fn()}
        >
          <Text>Seattle</Text>
        </MapDrawer>
      );
    });
  }

  // Zooming the map past the exploration cutoff takes `collapsed` away from the ME panel, while
  // the screen's own detent state still says `collapsed`. The drawer used to resolve its HEIGHT to
  // peek and say nothing, so the body went on rendering its collapsed one-liner inside an island
  // sized for the expanded one — and `measureBody`, which declines to measure at `collapsed`, kept
  // feeding that stale height back. The correction has to reach the caller.
  it('hands the caller back a detent that has left the allowed range', () => {
    const onDetentChange = jest.fn();
    render('peek', onDetentChange);
    expect(onDetentChange).toHaveBeenCalledWith('peek');
  });

  it('says nothing while the detent is still allowed', () => {
    const onDetentChange = jest.fn();
    render('collapsed', onDetentChange);
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('measures the body once the drawer is no longer really collapsed', () => {
    const onDetentChange = jest.fn();
    render('peek', onDetentChange);
    // The guard keys on where the drawer actually is, not on the stale prop — otherwise `peek`
    // keeps the height of a body that has left the screen.
    act(() => {
      measuredBody(renderer).props.onLayout({ nativeEvent: { layout: { height: 46 } } });
    });
    expect(renderer.root.findByType(ScrollView).props.scrollEnabled).toBe(false);
  });
});
