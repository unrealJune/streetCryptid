import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import { scaleFor } from '../../core/camera';
import { H3_MIN_LADDER_ZOOM } from '../../core/cell-ladder';
import { sunDirection } from '../../core/sunlight';
import { SunlightLayer } from '../sunlight-layer';

let mockActive = true;
jest.mock('@/hooks/use-is-app-active', () => ({
  useIsAppActive: () => mockActive,
}));
jest.mock('@shopify/react-native-skia', () => ({
  Rect: 'Rect',
  Shader: 'Shader',
  Skia: { RuntimeEffect: { Make: () => ({}) } },
}));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (value: unknown) => {
    const { useRef } = jest.requireActual('react');
    return useRef({ value }).current;
  },
  useDerivedValue: (factory: () => object) => ({
    get value() {
      return factory();
    },
  }),
  useAnimatedReaction: (prepare: () => boolean, react: (next: boolean) => void) => {
    const { useEffect } = jest.requireActual('react');
    const next = prepare();
    useEffect(() => react(next), [next, react]);
  },
  runOnJS: (fn: unknown) => fn,
}));

describe('SunlightLayer', () => {
  let renderer: ReactTestRenderer;
  const anchor = { center: [0.65, 0.4] as const, zoom: 12 };
  const viewport = { width: 390, height: 780 };
  const shared = (value: number) => ({ value }) as SharedValue<number>;
  const scale = shared(1);
  const translateX = shared(0);
  const translateY = shared(0);
  const draw = (zoom: number) => {
    scale.value = 2 ** (zoom - anchor.zoom);
    const layer = (
      <SunlightLayer
        anchor={anchor}
        viewport={viewport}
        scale={scale}
        translateX={translateX}
        translateY={translateY}
      />
    );
    act(() => {
      if (renderer) renderer.update(layer);
      else renderer = create(layer);
    });
  };
  const uniforms = () => renderer.root.findByType('Shader' as never).props.uniforms.value;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-20T12:00:00Z'));
    mockActive = true;
    translateX.value = 0;
    translateY.value = 0;
  });
  afterEach(() => {
    act(() => renderer.unmount());
    renderer = undefined as unknown as ReactTestRenderer;
    jest.useRealTimers();
  });

  it('starts no clock at terrain zoom and stops it when zooming back in', () => {
    draw(12);
    expect(renderer.toJSON()).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    draw(3);
    expect(jest.getTimerCount()).toBe(1);
    draw(H3_MIN_LADDER_ZOOM);
    expect(renderer.toJSON()).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes each minute, stops in the background, and catches up on resume', () => {
    draw(3);
    const noon = uniforms().uSun;
    act(() => jest.advanceTimersByTime(60_000));
    draw(3);
    expect(uniforms().uSun).not.toEqual(noon);
    mockActive = false;
    draw(3);
    expect(jest.getTimerCount()).toBe(0);
    act(() => jest.advanceTimersByTime(12 * 60 * 60_000));
    mockActive = true;
    draw(3);
    expect(uniforms().uSun).toEqual(sunDirection(Date.now()));
    expect(jest.getTimerCount()).toBe(1);
    act(() => renderer.unmount());
    expect(jest.getTimerCount()).toBe(0);
  });

  it('inverse-projects the live pan/zoom, independently of a tile commit', () => {
    const zoom = 3;
    const k = 2 ** (zoom - anchor.zoom);
    translateX.value = (viewport.width / 2) * (1 - k) + 70;
    translateY.value = (viewport.height / 2) * (1 - k) - 30;
    draw(zoom);
    const { uWorldOrigin, uWorldPerPixel } = uniforms();
    expect(uWorldPerPixel).toBeCloseTo(1 / scaleFor(zoom), 12);
    expect(uWorldOrigin[0] + (viewport.width / 2 + 70) * uWorldPerPixel).toBeCloseTo(
      anchor.center[0],
      12
    );
    expect(uWorldOrigin[1] + (viewport.height / 2 - 30) * uWorldPerPixel).toBeCloseTo(
      anchor.center[1],
      12
    );
  });
});
