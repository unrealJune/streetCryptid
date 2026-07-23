import { createH3Grid, realH3, type H3Core } from '../h3-grid';
import { latLonToWorld } from '../mercator';
import type { WorldRect } from '../types';

const SEATTLE = latLonToWorld({ lat: 47.6205, lon: -122.3169 });

describe('createH3Grid over real h3-js', () => {
  const grid = createH3Grid(realH3());

  it('round-trips a point through cellAt/centerWorld within one cell', () => {
    const cell = grid.cellAt(SEATTLE, 10);
    const [cx, cy] = grid.centerWorld(cell);
    // Res-10 cells are ~131 m across ≈ 2.7e-6 world units at Seattle's latitude.
    expect(Math.hypot(cx - SEATTLE[0], cy - SEATTLE[1])).toBeLessThan(3e-6);
    expect(grid.cellAt([cx, cy], 10)).toBe(cell);
  });

  it('reports 6 neighbors for a hexagon cell', () => {
    const cell = grid.cellAt(SEATTLE, 10);
    const neighbors = grid.neighborsOf(cell);
    expect(neighbors).toHaveLength(6);
    expect(neighbors).not.toContain(cell);
  });

  it('resolutionOf/parentOf/childrenSize agree with the hierarchy', () => {
    const cell = grid.cellAt(SEATTLE, 10);
    expect(grid.resolutionOf(cell)).toBe(10);
    const parent = grid.parentOf(cell, 7);
    expect(grid.resolutionOf(parent)).toBe(7);
    expect(grid.childrenSize(parent, 10)).toBe(7 ** 3);
  });

  it('boundaryWorld outlines the cell around its center', () => {
    const cell = grid.cellAt(SEATTLE, 10);
    const boundary = grid.boundaryWorld(cell);
    const [cx, cy] = grid.centerWorld(cell);
    expect(boundary.length).toBeGreaterThanOrEqual(5);
    for (const [x, y] of boundary) {
      expect(Math.hypot(x - cx, y - cy)).toBeLessThan(3e-6);
    }
  });

  it('keeps an antimeridian-straddling cell contiguous in world space', () => {
    const core = realH3();
    // A res-4 cell right on the dateline: raw boundary lngs flip ±180.
    const cell = core.latLngToCell(0, 180, 4);
    const rawLngs = core.cellToBoundary(cell).map(([, lng]) => lng);
    const rawSpan = Math.max(...rawLngs) - Math.min(...rawLngs);
    expect(rawSpan).toBeGreaterThan(180); // the raw form really does wrap

    const xs = grid.boundaryWorld(cell).map(([x]) => x);
    const span = Math.max(...xs) - Math.min(...xs);
    expect(span).toBeLessThan(0.01); // unwrapped: one narrow contiguous polygon
  });

  it('cellsInRect covers a street-zoom rect including edge-poking cells', () => {
    const half = 3e-5; // a few hundred meters
    const rect: WorldRect = {
      minX: SEATTLE[0] - half,
      minY: SEATTLE[1] - half,
      maxX: SEATTLE[0] + half,
      maxY: SEATTLE[1] + half,
    };
    const cells = grid.cellsInRect(rect, 10);
    expect(cells).toContain(grid.cellAt(SEATTLE, 10));
    // Corners are inside too (margin makes this strict).
    expect(cells).toContain(grid.cellAt([rect.minX, rect.minY], 10));
    expect(cells).toContain(grid.cellAt([rect.maxX, rect.maxY], 10));
    // Bounded: a ~12-cell-wide rect plus the 1.5-edge margin ring.
    expect(cells.length).toBeGreaterThan(100);
    expect(cells.length).toBeLessThan(400);
  });

  it('keeps async fallback enumeration identical to the synchronous path', async () => {
    const half = 3e-5;
    const rect: WorldRect = {
      minX: SEATTLE[0] - half,
      minY: SEATTLE[1] - half,
      maxX: SEATTLE[0] + half,
      maxY: SEATTLE[1] + half,
    };

    await expect(grid.cellsInRectAsync(rect, 10)).resolves.toEqual(grid.cellsInRect(rect, 10));
  });

  it('uses an injected async polygon enumerator without changing coverage', async () => {
    const core = realH3();
    const enumerate = jest.fn(async (loop: readonly [number, number][], resolution: number) =>
      core.polygonToCells([...loop], resolution)
    );
    const nativeGrid = createH3Grid(core, enumerate);
    const half = 3e-5;
    const rect: WorldRect = {
      minX: SEATTLE[0] - half,
      minY: SEATTLE[1] - half,
      maxX: SEATTLE[0] + half,
      maxY: SEATTLE[1] + half,
    };

    await expect(nativeGrid.cellsInRectAsync(rect, 10)).resolves.toEqual(
      grid.cellsInRect(rect, 10)
    );
    expect(enumerate).toHaveBeenCalledTimes(1);
  });

  it('surfaces a native failure and falls back to identical h3-js coverage', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const nativeGrid = createH3Grid(realH3(), () =>
      Promise.reject(new Error('native unavailable'))
    );
    const half = 3e-5;
    const rect: WorldRect = {
      minX: SEATTLE[0] - half,
      minY: SEATTLE[1] - half,
      maxX: SEATTLE[0] + half,
      maxY: SEATTLE[1] + half,
    };

    await expect(nativeGrid.cellsInRectAsync(rect, 10)).resolves.toEqual(
      grid.cellsInRect(rect, 10)
    );
    expect(warning).toHaveBeenCalledWith(
      '[map] native H3 enumeration failed; using h3-js fallback:',
      expect.any(Error)
    );
    warning.mockRestore();
  });

  it('enumerates the whole world at res 2 through the split path', () => {
    const world: WorldRect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const cells = grid.cellsInRect(world, 2);
    // 5,882 res-2 cells exist; the mercator cutoff (±85°) loses only polar caps.
    expect(cells.length).toBeGreaterThan(5000);
    expect(cells.length).toBeLessThanOrEqual(5882);
    // Both hemispheres, both sides of the antimeridian.
    expect(cells).toContain(grid.cellAt(latLonToWorld({ lat: 47.6, lon: -122.3 }), 2));
    expect(cells).toContain(grid.cellAt(latLonToWorld({ lat: -33.9, lon: 151.2 }), 2));
    expect(cells).toContain(grid.cellAt(latLonToWorld({ lat: 0, lon: 179.5 }), 2));
    // No duplicates across split boundaries.
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('returns nothing for a degenerate rect', () => {
    expect(grid.cellsInRect({ minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }, 10)).toEqual(
      expect.any(Array)
    );
  });
});

describe('createH3Grid lng unwrap against a fake core', () => {
  it('unwraps boundary vertices toward the cell center', () => {
    const fake: H3Core = {
      latLngToCell: () => 'cell',
      cellToLatLng: () => [0, 179.9],
      cellToBoundary: () => [
        [1, 179.8],
        [1, -179.9], // wrapped: really 180.1
        [-1, -179.7], // wrapped: really 180.3
        [-1, 179.9],
      ],
      cellToParent: () => 'parent',
      cellToChildrenSize: () => 7,
      getResolution: () => 4,
      polygonToCells: () => [],
      gridDisk: (c) => [c],
    };
    const xs = createH3Grid(fake)
      .boundaryWorld('cell')
      .map(([x]) => x);
    // All x sit just below/above 1.0 — no vertex jumped to the world's west edge.
    for (const x of xs) {
      expect(x).toBeGreaterThan(0.99);
      expect(x).toBeLessThan(1.01);
    }
  });
});
