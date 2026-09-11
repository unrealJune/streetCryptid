import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { cancelAnimation, withRepeat } from 'react-native-reanimated';

import type { ScreenHexLattice } from '../../core/hex-lattice';
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

const lattice: ScreenHexLattice = {
  originX: 320,
  originY: -180,
  radius: 96,
  rotation: 0.31,
  strokeWidth: 0.8,
};

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  jest.clearAllMocks();
});

function draw(options: { loading: boolean; reducedMotion?: boolean }) {
  act(() => {
    renderer = create(
      <LoadingHexGrid
        rect={{ x: 100000, y: -200000, width: 1170, height: 2532 }}
        lattice={lattice}
        loading={options.loading}
        reducedMotion={options.reducedMotion ?? false}
        ink={[40, 70, 80]}
      />
    );
  });
}

function uniforms() {
  return renderer!.root.findByType('Shader' as never).props.uniforms.value;
}

it('runs the sweep only while a build is in flight', () => {
  draw({ loading: true });
  expect(withRepeat).toHaveBeenCalledWith(1, -1, false);
  expect(uniforms().uSweep).toBe(1);
});

// A settled lattice is a static draw with nothing for Skia to repaint. Animating it unconditionally
// would pin a full-screen shader to the refresh rate for the whole life of the app.
it('leaves the settled lattice static, and still draws it', () => {
  draw({ loading: false });
  expect(withRepeat).not.toHaveBeenCalled();
  expect(cancelAnimation).toHaveBeenCalled();
  expect(uniforms().uSweep).toBe(0);
  expect(uniforms().uRadius).toBe(96);
});

it('keeps a visible but motionless grid when reduced motion is enabled', () => {
  draw({ loading: true, reducedMotion: true });
  expect(withRepeat).not.toHaveBeenCalled();
  expect(uniforms().uSweep).toBeGreaterThan(0);
});

// The shader's space is the Group's, which the translation puts at the rect's corner — an origin
// left in anchor space would drop the lattice a hundred thousand pixels off the map.
it('states the lattice origin relative to the rect it draws into', () => {
  draw({ loading: false });
  expect(uniforms().uOrigin).toEqual([320 - 100000, -180 + 200000]);
});
