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
  const { ScrollView, View } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: { ScrollView, View },
    scrollTo: () => {},
    useAnimatedRef: () => useRef(null),
    // The handler object itself, so a test can drive the list's offset through its callbacks.
    useAnimatedScrollHandler: (handlers: object) => handlers,
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    useDerivedValue: (factory: () => number) => ({ value: factory() }),
    interpolate: () => 0,
    runOnJS: (fn: () => void) => fn,
    withSpring: (value: number) => value,
    withTiming: (value: number) => value,
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

  // The grip is a plain handle whatever the body is doing: it ignores the rules a list drag follows.
  it('lets the grip collapse fully even from a list that owns its own drags', () => {
    const onDetentChange = render('full', 900);
    act(() => {
      const grip = mockPans[mockPans.length - 3];
      grip.start?.();
      grip.update?.({ translationY: 700, velocityY: 0 });
      grip.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('collapsed');
  });

  // Find My's rule: a pull down past the top of the list shrinks the sheet from where it is.
  it('shrinks the drawer when a list at its top is pulled down', () => {
    const onDetentChange = render('full', 900);
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 700, velocityY: 0 });
      body.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('collapsed');
  });

  it('leaves a downward drag to a list that is scrolled down', () => {
    const onDetentChange = render('full', 900);
    act(() => {
      renderer.root.findByType(ScrollView).props.onScroll.onScroll({ contentOffset: { y: 300 } });
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 200, velocityY: 0 });
      body.end?.({ translationY: 200, velocityY: 0 });
    });
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('expands one stop when the grip is tapped', () => {
    const onDetentChange = render('collapsed');
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Panel size' }).props.onPress());
    expect(onDetentChange).toHaveBeenCalledWith('peek');
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

  it('shrinks a scrollable body pulled down from the top of its list', () => {
    const onDetentChange = render({ detent: 'mid', maxDetent: 'mid', bodyHeight: 500 });
    dragBodyDown();
    expect(onDetentChange).toHaveBeenCalledWith('peek');
  });

  // The roster reported on iOS: full of friends, resting below its top stop, and not scrolling.
  it('scrolls a list that does not fit, below the top detent too', () => {
    render({ detent: 'peek', maxDetent: 'mid', bodyHeight: 500 });
    expect(renderer.root.findByType(ScrollView).props.scrollEnabled).toBe(true);
  });

  // Growing is the grip's and the header's job once the body is a list; a drag up reads it.
  it('never grows the drawer from an upward drag on a list', () => {
    const onDetentChange = render({ detent: 'peek', maxDetent: 'mid', bodyHeight: 500 });
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: -400, velocityY: -2000 });
      body.end?.({ translationY: -400, velocityY: -2000 });
    });
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('gives a drag back up only as far as where it started', () => {
    const onDetentChange = render({ detent: 'mid', maxDetent: 'mid', bodyHeight: 500 });
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: 60, velocityY: 0 });
      body.update?.({ translationY: -300, velocityY: 0 });
      body.end?.({ translationY: -300, velocityY: -2000 });
    });
    expect(onDetentChange).not.toHaveBeenCalled();
  });

  it('still grows from a body drag when the body has nothing to scroll', () => {
    const onDetentChange = render({ detent: 'peek', maxDetent: 'mid', bodyHeight: 100 });
    act(() => {
      const body = mockPans[mockPans.length - 1];
      body.start?.();
      body.update?.({ translationY: -400, velocityY: 0 });
      body.end?.({ translationY: -400, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('mid');
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

describe('MapDrawer — pinned at collapsed', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(maxDetent: 'collapsed' | 'peek') {
    act(() => {
      renderer = create(
        <MapDrawer
          activeTab="me"
          detent="collapsed"
          minDetent="collapsed"
          maxDetent={maxDetent}
          insetBottom={34}
          insetTop={59}
          screenHeight={844}
          signal="#2f9e6a"
          theme={CryptidThemes.daybreak}
          onDetentChange={jest.fn()}
          onSelectTab={jest.fn()}
        >
          <Text>Washington</Text>
        </MapDrawer>
      );
    });
  }

  // Zooming out past the band where coverage is measurable leaves ME with `collapsed` as its only
  // stop. It must lose the grip — there is nowhere to drag to — but not the strip's height, or the
  // bubble shrinks by a grip at the moment the map crosses the cutoff.
  it('keeps the grip strip’s space but drops the control', () => {
    render('collapsed');
    expect(hosts(renderer, { accessibilityLabel: 'Panel size' })).toHaveLength(0);
    expect(hosts(renderer, { testID: 'map-drawer-grip-space' })).toHaveLength(1);
  });

  it('has the control back as soon as there is somewhere to drag', () => {
    render('peek');
    expect(hosts(renderer, { accessibilityLabel: 'Panel size' })).toHaveLength(1);
    expect(hosts(renderer, { testID: 'map-drawer-grip-space' })).toHaveLength(0);
  });

  it('does not let the clipped body scroll while pinned', () => {
    render('collapsed');
    act(() => {
      measuredBody(renderer).props.onLayout({ nativeEvent: { layout: { height: 92 } } });
    });
    expect(renderer.root.findByType(ScrollView).props.scrollEnabled).toBe(false);
  });
});

describe('MapDrawer header', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPans.length = 0;
  });

  function render(detent: 'peek' | 'full') {
    const onDetentChange = jest.fn();
    act(() => {
      renderer = create(
        <MapDrawer
          activeTab="friends"
          detent={detent}
          header={<Text>3 NEARBY</Text>}
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
    act(() => {
      headerHost(renderer).props.onLayout({ nativeEvent: { layout: { height: 34 } } });
    });
    act(() => {
      measuredBody(renderer).props.onLayout({ nativeEvent: { layout: { height: 500 } } });
    });
    return onDetentChange;
  }

  function headerHost(r: ReactTestRenderer) {
    return r.root.findAll((node) => node.props.testID === 'map-drawer-header')[0];
  }

  it('expands one stop when tapped', () => {
    const onDetentChange = render('peek');
    act(() => {
      headerHost(renderer)
        .findAll((node) => node.props.accessible === false && node.props.onPress)[0]
        .props.onPress();
    });
    expect(onDetentChange).toHaveBeenCalledWith('mid');
  });

  it('floats over the list, which starts below it', () => {
    render('peek');
    const content = renderer.root.findByType(ScrollView).props.contentContainerStyle;
    expect(content).toEqual(expect.arrayContaining([{ paddingTop: 34 }]));
  });

  it('is a handle: dragging it down shrinks the drawer', () => {
    const onDetentChange = render('full');
    act(() => {
      const header = mockPans[mockPans.length - 2];
      header.start?.();
      header.update?.({ translationY: 700, velocityY: 0 });
      header.end?.({ translationY: 700, velocityY: 0 });
    });
    expect(onDetentChange).toHaveBeenCalledWith('collapsed');
  });
});

/** Host Views carrying `props` — `findAllByProps` also matches the composite wrapping each one. */
function hosts(renderer: ReactTestRenderer, props: Record<string, string>) {
  return renderer.root
    .findAllByType(View)
    .filter((node) => Object.entries(props).every(([key, value]) => node.props[key] === value));
}
