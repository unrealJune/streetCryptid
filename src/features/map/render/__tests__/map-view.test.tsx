import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { withDecay, withTiming } from 'react-native-reanimated';

import { CryptidThemes } from '@/constants/cryptid-theme';
import {
  applyViewTransform,
  scaleFor,
  viewTransformFor,
  worldToScreen,
  type ViewTransform,
} from '../../core/camera';
import { makeViewLimits } from '../../core/gesture';
import { latLonToWorld } from '../../core/mercator';
import type { CameraState, LatLon, ScreenPoint } from '../../core/types';
import { useMapEngine, type MapEngineState } from '../../hooks/use-map-engine';
import { useMapPerfRunner } from '../../perf/use-map-perf-runner';
import { MapView } from '../map-view';
import { RegionLayer } from '../region-layer';
import { LoadingHexGrid } from '../loading-hex-grid';
import { FriendClusterPuck } from '../friend-cluster-puck';

jest.mock('react-native-reanimated', () => {
  const { useRef } = jest.requireActual('react');
  const animations = new Map();
  const ui: (() => void)[] = [];
  const cancelAnimation = jest.fn((sv) => {
    const animation = animations.get(sv);
    animations.delete(sv);
    animation?.callback?.(false);
  });
  return {
    useSharedValue: (initial: unknown) => {
      const ref = useRef(null);
      if (!ref.current) {
        let current = initial;
        const sv = {
          get value() {
            return current;
          },
          set value(next) {
            cancelAnimation(sv);
            if (next && typeof next === 'object' && '__animation' in next) {
              animations.set(sv, { ...next, from: current });
            } else current = next;
          },
          frame(value: unknown) {
            current = value;
          },
        };
        ref.current = sv;
      }
      return ref.current;
    },
    useDerivedValue: (fn: () => unknown) => ({
      get value() {
        return fn();
      },
    }),
    useAnimatedReaction: jest.fn(),
    useReducedMotion: () => false,
    withTiming: jest.fn((to, config, callback) => ({ __animation: true, to, config, callback })),
    withDecay: jest.fn((config, callback) => ({ __animation: true, to: 100, config, callback })),
    withRepeat: (animation: unknown) => animation,
    cancelAnimation,
    runOnJS: (fn: () => void) => fn,
    runOnUI:
      (fn: (...args: never[]) => void) =>
      (...args: never[]) =>
        ui.push(() => fn(...args)),
    Easing: {
      cubic: (n: number) => n ** 3,
      out: (fn: unknown) => fn,
      inOut: (fn: unknown) => fn,
      linear: (n: number) => n,
    },
    ReduceMotion: { Never: 'never' },
    driver: {
      flush() {
        while (ui.length) ui.shift()!();
      },
      frame(p: number) {
        // p is the eased progress delivered by Reanimated, not wall-clock time.
        for (const [sv, animation] of animations) {
          sv.frame(animation.from + (animation.to - animation.from) * p);
          if (p === 1) {
            animations.delete(sv);
            animation.callback?.(true);
          }
        }
      },
      clear() {
        animations.clear();
        ui.length = 0;
      },
      count() {
        return animations.size;
      },
    },
  };
});
jest.mock('react-native-gesture-handler', () => {
  function gesture() {
    const value: Record<string, unknown> = { callbacks: {} };
    for (const name of [
      'enabled',
      'maxPointers',
      'numberOfTaps',
      'maxDuration',
      'onBegin',
      'onChange',
      'onEnd',
    ]) {
      value[name] = (arg: unknown) => {
        (value.callbacks as Record<string, unknown>)[name] = arg;
        return value;
      };
    }
    return value;
  }
  return {
    GestureDetector: 'GestureDetector',
    Gesture: {
      Pan: gesture,
      Pinch: gesture,
      Tap: gesture,
      Race: (...children: unknown[]) => children,
      Simultaneous: (...children: unknown[]) => children,
    },
  };
});
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: 'Canvas',
  Group: 'Group',
  Image: 'Image',
  ImageShader: 'ImageShader',
  Rect: 'Rect',
  Shader: 'Shader',
  Path: 'Path',
  Circle: 'Circle',
  Skia: {
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    RuntimeEffect: { Make: () => ({}) },
    Path: {
      Make: () => {
        const commands: number[][] = [];
        return {
          commands,
          moveTo: (x: number, y: number) => commands.push([x, y]),
          lineTo: (x: number, y: number) => commands.push([x, y]),
        };
      },
    },
  },
}));
jest.mock('../../hooks/use-map-engine', () => ({ useMapEngine: jest.fn() }));
jest.mock('../../perf/use-map-perf-runner', () => ({ useMapPerfRunner: jest.fn() }));
jest.mock('../../perf/map-perf', () => ({
  emitMapPerfEvent: jest.fn(),
  isMapPerfRunEnabled: () => false,
}));
jest.mock('../region-shader', () => ({
  makeLutImage: () => ({}),
  makeMaskImage: () => ({}),
  makeCellStateImage: () => ({}),
  renderRegionImage: () => ({}),
}));
jest.mock('../friend-locator', () => ({ FriendLocator: () => null }));
jest.mock('../friend-cluster-puck', () => ({ FriendClusterPuck: () => null }));
jest.mock('../friend-locator-stack', () => ({ FriendLocatorStack: () => null }));
jest.mock('../you-locator', () => ({ YouLocator: () => null }));
jest.mock('../map-labels', () => ({ MapLabelLayer: () => null }));
jest.mock('../ocean-cryptid-layer', () => ({ OceanCryptidLayer: () => null }));
jest.mock('@/hooks/use-is-app-active', () => ({ useIsAppActive: () => false }));

const driver = jest.requireMock('react-native-reanimated').driver;
const viewport = { width: 390, height: 844 };
const anchor: CameraState = { center: latLonToWorld({ lat: 47.6062, lon: -122.3321 }), zoom: 15 };
const cities = [
  { lat: 35.6762, lon: 139.6503 }, // Tokyo
  { lat: 48.8566, lon: 2.3522 }, // Paris
  { lat: -33.8688, lon: 151.2093 }, // Sydney
];
let engine: MapEngineState;
let renderer: ReactTestRenderer;

function regionAt(camera: CameraState, shift = 0): MapEngineState['region'] {
  const s = scaleFor(camera.zoom);
  return {
    spec: {
      rect: {
        minX: camera.center[0] - (500 - shift) / s,
        maxX: camera.center[0] + (500 + shift) / s,
        minY: camera.center[1] - 1000 / s,
        maxY: camera.center[1] + 1000 / s,
      },
      zoom: camera.zoom,
      tileZoom: 14,
      cellRes: 9,
      maskWidth: 1000,
      maskHeight: 2000,
    },
    labels: [],
    places: [],
    cellField: { cells: [] },
  } as unknown as MapEngineState['region'];
}

beforeEach(() => {
  driver.clear();
  jest.clearAllMocks();
  engine = {
    theme: CryptidThemes.daybreak,
    dataZooms: { min: 0, max: 14 },
    anchor,
    camera: anchor,
    limits: makeViewLimits(anchor, viewport, {
      minZoom: 1,
      maxZoom: 18,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    }),
    region: regionAt(anchor),
    pending: null,
    coverage: 0,
    sectorsVisible: true,
    placeName: null,
    hexLattice: { center: anchor.center, radius: 1e-6, rotation: 0.2, res: 9 },
    commit: jest.fn(),
    prefetchAt: jest.fn(async () => {}),
  };
  jest.mocked(useMapEngine).mockImplementation(() => engine);
});
afterEach(() => {
  act(() => renderer?.unmount());
});

function mount(props: Partial<React.ComponentProps<typeof MapView>> = {}) {
  act(() => {
    renderer = create(<MapView {...props} />);
  });
  act(() => {
    renderer.root
      .findByProps({ testID: 'map-view' })
      .props.onLayout({ nativeEvent: { layout: viewport } });
  });
  act(() => {
    driver.flush();
    driver.frame(1);
  });
}
function gesture() {
  return renderer.root.findByType('GestureDetector' as never).props.gesture;
}
function live() {
  return renderer.root.findAllByType(RegionLayer)[0].props.camera.value as ViewTransform;
}
function profile(to: ViewTransform) {
  const animate = jest.mocked(useMapPerfRunner).mock.calls.at(-1)![0].animate;
  animate(to, 7, 300, jest.fn());
  driver.flush();
}
function moveTo(location: LatLon, zoom: number) {
  const camera = { center: latLonToWorld(location), zoom };
  act(() => {
    profile(viewTransformFor(anchor, viewport, camera));
    driver.frame(1);
  });
  engine = {
    ...engine,
    camera,
    region: regionAt(camera),
    hexLattice: { center: camera.center, radius: 1e-6, rotation: 0.2, res: 9 },
  };
  act(() => {
    renderer.update(<MapView />);
  });
  act(() => driver.frame(1));
}
function floatPoint(
  ops: { translateX?: number; translateY?: number; scale?: number }[],
  p: ScreenPoint
) {
  const f = Math.fround;
  return [
    f(f(f(p[0]) * f(ops[2].scale!)) + f(ops[0].translateX!)),
    f(f(f(p[1]) * f(ops[2].scale!)) + f(ops[1].translateY!)),
  ];
}
function expectPoint(actual: readonly number[], expected: readonly number[], tolerance = 0.002) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThan(tolerance);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThan(tolerance);
}

it.each(cities.flatMap((city) => [17, 18].map((zoom) => ({ city, zoom }))))(
  'renders subpixel pans and swaps in $city at zoom $zoom with a Seattle anchor',
  ({ city, zoom }) => {
    mount();
    moveTo(city, zoom);
    const cameraBefore = live();
    const pan = gesture()[1][0].callbacks;
    act(() => {
      pan.onBegin();
      pan.onChange({ changeX: 0.125, changeY: -0.375 });
    });
    const current = renderer.root.findAllByType(RegionLayer).at(-1)!;
    const rect = current.props.rect;
    const group = current.findByType('Group' as never);
    const point: ScreenPoint = [
      (viewport.width / 2 - rect.x * cameraBefore.k - cameraBefore.tx) / cameraBefore.k,
      (viewport.height / 2 - rect.y * cameraBefore.k - cameraBefore.ty) / cameraBefore.k,
    ];
    expectPoint(floatPoint(group.props.transform.value, point), [195.125, 421.625]);
    const oldPath = floatPoint(
      [{ translateX: live().tx }, { translateY: live().ty }, { scale: live().k }],
      [rect.x + point[0], rect.y + point[1]]
    );
    expect(Math.hypot(oldPath[0] - 195.125, oldPath[1] - 421.625)).toBeGreaterThan(0.05);

    const grid = renderer.root.findByType(LoadingHexGrid);
    const gridGroup = grid.findByType('Group' as never);
    const gridOrigin = grid.findAllByType('Shader' as never)[0].props.uniforms.value.uOrigin;
    expectPoint(floatPoint(gridGroup.props.transform.value, gridOrigin), [195.125, 421.625]);

    const beforeSwap = live();
    engine = { ...engine, region: regionAt(engine.camera, 80) };
    act(() => renderer.update(<MapView />));
    expect(live()).toEqual(beforeSwap);
    const incoming = renderer.root.findAllByType(RegionLayer).at(-1)!;
    const shaders = incoming.findAllByType('ImageShader' as never);
    expect(shaders).toHaveLength(2);
    expect(shaders[0].props.rect).toEqual(shaders[1].props.rect);
    expect(shaders[0].props.rect.x).toBe(0);
    expect(shaders[0].props.rect.y).toBe(0);
    const coverage = incoming.findByType('Shader' as never).props.uniforms.value.uPrevRect;
    expect(coverage[0]).toBe(0);
    expect(coverage[2]).toBeCloseTo(920 / live().k, 4);
    const incomingRect = incoming.props.rect;
    const incomingPoint: ScreenPoint = [
      rect.x + point[0] - incomingRect.x,
      rect.y + point[1] - incomingRect.y,
    ];
    expectPoint(
      floatPoint(incoming.findByType('Group' as never).props.transform.value, incomingPoint),
      [195.125, 421.625]
    );
    act(() => driver.frame(1));
    expect(incoming.findAllByType('ImageShader' as never)).toHaveLength(0);
    expect(live()).toEqual(beforeSwap);
  }
);

it('double-tap has one clock, stays focal through a region swap, and touch-down preserves its displayed state', () => {
  mount();
  moveTo(cities[0], 17);
  jest.mocked(withTiming).mockClear();
  const focal = { x: 123.25, y: 456.75 };
  const start = live();
  const point: ScreenPoint = [(focal.x - start.tx) / start.k, (focal.y - start.ty) / start.k];
  act(() => gesture()[0].callbacks.onEnd(focal, true));
  expect(withTiming).toHaveBeenCalledTimes(1);
  expect(jest.mocked(withTiming).mock.calls[0][0]).toBe(1);
  for (const p of [0.07, 0.23, 0.51, 0.79]) {
    act(() => driver.frame(p));
    const t = live();
    expectPoint([point[0] * t.k + t.tx, point[1] * t.k + t.ty], [focal.x, focal.y], 1e-7);
  }
  const displayed = live();
  engine = { ...engine, region: regionAt(engine.camera, 40) };
  act(() => renderer.update(<MapView />));
  expect(live()).toEqual(displayed);
  act(() => gesture()[1][0].callbacks.onBegin());
  expect(live()).toEqual(displayed);
  act(() => {
    driver.frame(1);
    gesture()[1][0].callbacks.onChange({ changeX: 0.25, changeY: 0.5 });
  });
  expect(live()).toEqual({ ...displayed, tx: displayed.tx + 0.25, ty: displayed.ty + 0.5 });
  act(() => gesture()[1][0].callbacks.onEnd({ velocityX: 0, velocityY: 0 }));
  expect(engine.commit).toHaveBeenLastCalledWith(live());
});

it('locate and perf use one UI transaction and interrupt from the currently displayed camera', () => {
  mount();
  moveTo(cities[0], 17);
  const before = live();
  jest.mocked(withTiming).mockClear();
  act(() => renderer.update(<MapView locateTarget={{ requestId: 1, location: cities[1] }} />));
  expect(live()).toEqual(before); // JS has only enqueued work, not written half a camera.
  act(() => driver.flush());
  expect(withTiming).toHaveBeenCalledTimes(1);
  const target = jest.mocked(engine.commit).mock.calls.at(-1)![0];
  act(() => driver.frame(0.4));
  expect(live().k).toBeCloseTo(before.k + (target.k - before.k) * 0.4, 10);
  const displayed = live();
  const to = viewTransformFor(anchor, viewport, { center: latLonToWorld(cities[2]), zoom: 18 });
  jest.mocked(withTiming).mockClear();
  act(() => profile(to));
  expect(live()).toEqual(displayed);
  expect(withTiming).toHaveBeenCalledTimes(1);
  act(() => driver.frame(0.5));
  expect(live()).toEqual({
    k: displayed.k + (to.k - displayed.k) / 2,
    tx: displayed.tx + (to.tx - displayed.tx) / 2,
    ty: displayed.ty + (to.ty - displayed.ty) / 2,
  });
  act(() => driver.frame(1));
  expect(live()).toEqual(to);
  engine = {
    ...engine,
    camera: { center: latLonToWorld(cities[2]), zoom: 18 },
    region: regionAt({ center: latLonToWorld(cities[2]), zoom: 18 }),
  };
  act(() => renderer.update(<MapView />));
  const incoming = renderer.root.findAllByType(RegionLayer).at(-1)!;
  expect(incoming.findByType('Shader' as never).props.uniforms.value.uPrevRect).toEqual([
    0, 0, 0, 0,
  ]);
  expect(live()).toEqual(to);
});

it('cancels both fling decays before a new animation and never commits the cancelled destination', () => {
  mount();
  moveTo(cities[0], 17);
  const pan = gesture()[1][0].callbacks;
  act(() => {
    pan.onBegin();
    pan.onEnd({ velocityX: 150, velocityY: -100 });
    driver.frame(0.05);
  });
  expect(withDecay).toHaveBeenCalledTimes(2);
  const displayed = live();
  jest.mocked(engine.commit).mockClear();
  act(() => gesture()[0].callbacks.onEnd({ x: 120, y: 300 }, true));
  expect(live()).toEqual(displayed);
  expect(driver.count()).toBe(1);
  expect(engine.commit).not.toHaveBeenCalled();
  act(() => driver.frame(1));
  expect(engine.commit).toHaveBeenCalledTimes(1);
  expect(engine.commit).toHaveBeenCalledWith(live());
});

it('resizes atomically on UI from the displayed frame, without changing the world camera', () => {
  mount();
  moveTo(cities[0], 17);
  act(() => {
    gesture()[0].callbacks.onEnd({ x: 130, y: 320 }, true);
    driver.frame(0.38);
  });
  const displayed = live();
  const before = applyViewTransform(anchor, viewport, displayed);
  const resized = { width: 844, height: 390 };
  act(() =>
    renderer.root.findByProps({ testID: 'map-view' }).props.onLayout({
      nativeEvent: { layout: resized },
    })
  );
  expect(live()).toEqual(displayed);
  act(() => driver.flush());
  const after = applyViewTransform(anchor, resized, live());
  expect(after.zoom).toBeCloseTo(before.zoom, 12);
  expectPoint(after.center, before.center, 1e-12);
  const settled = live();
  act(() => driver.frame(1));
  expect(live()).toEqual(settled);
});

it('cluster zoom uses the same clock and focal point, even while interrupting another zoom', () => {
  const friends = Array.from({ length: 5 }, (_, i) => ({
    id: `${i}`,
    handle: `${i}`,
    sigil: '?',
    color: '#fff',
    location: cities[0],
    latestTs: 0,
  }));
  mount({ friends });
  act(() => {
    profile(viewTransformFor(anchor, viewport, { center: latLonToWorld(cities[0]), zoom: 16 }));
    driver.frame(1);
  });
  act(() => gesture()[0].callbacks.onEnd({ x: 140, y: 400 }, true));
  act(() => driver.frame(0.35));
  const from = live();
  const point = worldToScreen(anchor, viewport, latLonToWorld(cities[0]));
  const focal = [point[0] * from.k + from.tx, point[1] * from.k + from.ty];
  jest.mocked(withTiming).mockClear();
  act(() => renderer.root.findByType(FriendClusterPuck).props.onPress());
  expect(live()).toEqual(from);
  act(() => driver.flush());
  expect(withTiming).toHaveBeenCalledTimes(1);
  for (const p of [0.1, 0.6, 1]) {
    act(() => driver.frame(p));
    const t = live();
    expectPoint([point[0] * t.k + t.tx, point[1] * t.k + t.ty], focal, 1e-7);
  }
});

it('clips a selected intercontinental trail before any coordinates reach Skia float32', () => {
  mount();
  moveTo(cities[0], 18);
  const camera = applyViewTransform(anchor, viewport, live());
  const history = [cities[1], cities[0], cities[2]].map((location, i) => ({
    id: `${i}`,
    location,
  }));
  act(() => renderer.update(<MapView selfSelected selfHistory={history} />));
  const commands: number[][] = renderer.root.findByType('Path' as never).props.path.value.commands;
  expect(commands.length).toBeGreaterThan(0);
  for (const [x, y] of commands) {
    expect(x).toBeGreaterThanOrEqual(-4.00001);
    expect(x).toBeLessThanOrEqual(viewport.width + 4.00001);
    expect(y).toBeGreaterThanOrEqual(-4.00001);
    expect(y).toBeLessThanOrEqual(viewport.height + 4.00001);
  }
  const dots = renderer.root.findAllByType('Circle' as never);
  expectPoint(
    [Math.fround(dots[1].props.cx.value), Math.fround(dots[1].props.cy.value)],
    worldToScreen(camera, viewport, latLonToWorld(cities[0]))
  );
  expect([dots[0].props.cx.value, dots[0].props.cy.value]).toEqual([-10, -10]);
  expectPoint(commands[1].map(Math.fround), [195, 422]);
  act(() => {
    const pan = gesture()[1][0].callbacks;
    pan.onBegin();
    pan.onChange({ changeX: 0.125, changeY: -0.375 });
  });
  const moved = renderer.root.findByType('Path' as never).props.path.value.commands;
  expectPoint(moved[1].map(Math.fround), [195.125, 421.625]);
  expectPoint(
    [Math.fround(dots[1].props.cx.value), Math.fround(dots[1].props.cy.value)],
    [195.125, 421.625]
  );
  const crossing = [-20, 20].map((offset) => ({
    id: `${offset}`,
    location: { ...cities[0], lon: cities[0].lon + offset },
  }));
  act(() => renderer.update(<MapView selfSelected selfHistory={crossing} />));
  const clipped = renderer.root.findByType('Path' as never).props.path.value.commands;
  expectPoint(clipped[0].map(Math.fround), [-4, 421.625]);
  expectPoint(clipped[1].map(Math.fround), [viewport.width + 4, 421.625]);
});
