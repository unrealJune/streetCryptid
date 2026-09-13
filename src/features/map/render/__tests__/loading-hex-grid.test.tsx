import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { cancelAnimation, withRepeat } from 'react-native-reanimated';

import type { ScreenHexLattice } from '../../core/hex-lattice';
import { LoadingHexGrid, punchRect } from '../loading-hex-grid';

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

const RECT = { x: 100000, y: -200000, width: 1170, height: 2532 };

function draw(options: {
  loading: boolean;
  reducedMotion?: boolean;
  covered?: { x: number; y: number; width: number; height: number } | null;
}) {
  act(() => {
    renderer = create(
      <LoadingHexGrid
        rect={RECT}
        covered={options.covered ?? null}
        lattice={lattice}
        loading={options.loading}
        reducedMotion={options.reducedMotion ?? false}
        ink={[40, 70, 80]}
      />
    );
  });
}

function uniforms() {
  return renderer!.root.findAllByType('Shader' as never)[0].props.uniforms.value;
}

function drawnRects() {
  return renderer!.root.findAllByType('Rect' as never).map((node) => node.props);
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

// The whole reason the skeleton can afford to stay mounted: the region bitmap is opaque, so every
// pixel of lattice under it was shaded and then covered.
it('cuts the covered region out of the draw rather than shading under it', () => {
  draw({ loading: false, covered: { x: 100200, y: -199800, width: 400, height: 500 } });
  const rects = drawnRects();
  expect(rects).toHaveLength(4);
  // Nothing drawn overlaps the hole, and the four pieces add back up to the whole rect.
  const hole = { left: 200, right: 600, top: 200, bottom: 700 };
  for (const rect of rects) {
    const overlapsX = rect.x < hole.right && rect.x + rect.width > hole.left;
    const overlapsY = rect.y < hole.bottom && rect.y + rect.height > hole.top;
    expect(overlapsX && overlapsY).toBe(false);
  }
  const area = rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);
  expect(area).toBe(RECT.width * RECT.height - 400 * 500);
});

it('draws the whole rect when nothing is covering it', () => {
  draw({ loading: true });
  expect(drawnRects()).toEqual([
    expect.objectContaining({ x: 0, y: 0, width: RECT.width, height: RECT.height }),
  ]);
});

describe('punchRect', () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };

  it('keeps the whole rect when the hole misses it', () => {
    expect(punchRect(outer, { x: 400, y: 400, width: 10, height: 10 })).toEqual([
      { x: 0, y: 0, width: 100, height: 100 },
    ]);
  });

  // A region larger than the view is the ordinary case, and the one the cut exists for: it must
  // leave nothing at all to draw.
  it('leaves nothing when the hole swallows the rect', () => {
    expect(punchRect(outer, { x: -50, y: -50, width: 400, height: 400 })).toEqual([]);
  });

  it('drops the empty sides of a hole flush with an edge', () => {
    expect(punchRect(outer, { x: -20, y: -20, width: 70, height: 400 })).toEqual([
      { x: 50, y: 0, width: 50, height: 100 },
    ]);
  });
});
