import { scaleFor } from '../camera';
import { createH3Grid, realH3, type H3Grid } from '../h3-grid';
import { GHOST_LATTICE_WIDTH, measureHexLattice, projectHexLattice } from '../hex-lattice';
import { latLonToWorld } from '../mercator';
import type { CameraState, Viewport } from '../types';

const viewport: Viewport = { width: 402, height: 874 };
const seattle = latLonToWorld({ lat: 47.62, lon: -122.32 });

let grid: H3Grid;
beforeAll(() => {
  grid = createH3Grid(realH3());
});

describe('measureHexLattice', () => {
  it('measures the cell the camera is actually standing in', () => {
    const lattice = measureHexLattice(grid, seattle, 9);

    expect(lattice).not.toBeNull();
    const cell = grid.cellAt(seattle, 9);
    expect(lattice!.center).toEqual(grid.centerWorld(cell));
    expect(lattice!.res).toBe(9);
  });

  // The whole point: a skeleton hex has to be the size of the hex that will replace it. Compare
  // against the real cell's own vertices rather than a number typed in here.
  it('carries the real cell radius, not a fixed screen size', () => {
    const lattice = measureHexLattice(grid, seattle, 9)!;
    const cell = grid.cellAt(seattle, 9);
    const [cx, cy] = grid.centerWorld(cell);
    const spans = grid.boundaryWorld(cell).map(([x, y]) => Math.hypot(x - cx, y - cy));

    expect(lattice.radius).toBeGreaterThanOrEqual(Math.min(...spans));
    expect(lattice.radius).toBeLessThanOrEqual(Math.max(...spans));
  });

  // One rung coarser is √7 longer in the edge, and the skeleton has to follow the ladder up.
  it('grows with the ladder rung', () => {
    const fine = measureHexLattice(grid, seattle, 9)!;
    const coarse = measureHexLattice(grid, seattle, 8)!;

    expect(coarse.radius / fine.radius).toBeCloseTo(Math.sqrt(7), 1);
  });

  it('folds rotation into one sixth of a turn, the symmetry of the tiling', () => {
    for (const res of [4, 6, 8, 9]) {
      const lattice = measureHexLattice(grid, seattle, res)!;
      expect(lattice.rotation).toBeGreaterThanOrEqual(0);
      expect(lattice.rotation).toBeLessThan(Math.PI / 3);
    }
  });
});

describe('projectHexLattice', () => {
  const anchor: CameraState = { center: seattle, zoom: 14 };

  it('puts the reference cell where the anchor camera sees it', () => {
    const lattice = measureHexLattice(grid, seattle, 9)!;
    const projected = projectHexLattice(lattice, anchor, anchor, viewport);

    // The measured cell's centre is within one cell of the camera, so it lands near mid-screen.
    expect(projected.originX).toBeCloseTo(viewport.width / 2, -2);
    expect(projected.originY).toBeCloseTo(viewport.height / 2, -2);
    expect(projected.radius).toBeCloseTo(lattice.radius * scaleFor(anchor.zoom), 6);
  });

  // The real lattice is a 1px stroke inside a bitmap that anchor space shrinks by the committed
  // scale. Pre-dividing is what keeps the two the same weight on screen.
  it('pre-divides the stroke by the committed scale', () => {
    const lattice = measureHexLattice(grid, seattle, 9)!;
    const zoomedIn: CameraState = { center: seattle, zoom: 16 };

    expect(projectHexLattice(lattice, anchor, anchor, viewport).strokeWidth).toBeCloseTo(
      GHOST_LATTICE_WIDTH,
      6
    );
    expect(projectHexLattice(lattice, anchor, zoomedIn, viewport).strokeWidth).toBeCloseTo(
      GHOST_LATTICE_WIDTH / 4,
      6
    );
  });
});
