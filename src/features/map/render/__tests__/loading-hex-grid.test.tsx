import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  cancelAnimation,
  useSharedValue,
  withRepeat,
  type SharedValue,
} from 'react-native-reanimated';
import { LoadingHexGrid } from '../loading-hex-grid';

jest.mock('@shopify/react-native-skia', () => ({
  Group: 'Group',
  Rect: 'Rect',
  Shader: 'Shader',
  Skia: { RuntimeEffect: { Make: () => ({}) } },
}));

jest.mock('react-native-reanimated', () => ({
  useSharedValue: jest.fn((value: number) => ({ value })),
  useDerivedValue: (fn: () => object) => ({ value: fn() }),
  Easing: { linear: (n: number) => n },
  withTiming: (n: number) => n,
  withRepeat: jest.fn((n: number) => n),
  cancelAnimation: jest.fn(),
}));

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  jest.clearAllMocks();
});

function draw(reducedMotion: boolean) {
  act(() => {
    renderer = create(
      <LoadingHexGrid
        rect={{ x: 100000, y: -200000, width: 1170, height: 2532 }}
        scale={{ value: 1 } as SharedValue<number>}
        reducedMotion={reducedMotion}
        ink={[40, 70, 80]}
      />
    );
  });
}

it('runs a slow repeating sweep only while the loading layer is mounted', () => {
  draw(false);
  expect(withRepeat).toHaveBeenCalledWith(1, -1, false);
  act(() => renderer?.unmount());
  renderer = undefined;
  expect(cancelAnimation).toHaveBeenCalled();
});

it('keeps a static visible hex grid when reduced motion is enabled', () => {
  draw(true);
  expect(withRepeat).not.toHaveBeenCalled();
  const values = jest.mocked(useSharedValue).mock.results;
  expect(values.some((r) => r.value.value === 0.5)).toBe(true);
});
