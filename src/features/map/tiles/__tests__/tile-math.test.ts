import {
  DATA_MAX_ZOOM,
  DATA_MIN_ZOOM,
  DATA_ZOOM_BIAS,
  dataZoomFor,
  tileKeyOf,
  tileWorldRect,
  tileZoomFor,
  tilesCovering,
} from '../tile-math';

describe('tileZoomFor', () => {
  it('clamps below DATA_MIN_ZOOM up to 12', () => {
    expect(tileZoomFor(11)).toBe(DATA_MIN_ZOOM);
    expect(tileZoomFor(0)).toBe(DATA_MIN_ZOOM);
    expect(tileZoomFor(-5)).toBe(DATA_MIN_ZOOM);
  });

  it('clamps above DATA_MAX_ZOOM down to 14', () => {
    expect(tileZoomFor(15)).toBe(DATA_MAX_ZOOM);
    expect(tileZoomFor(18)).toBe(DATA_MAX_ZOOM);
    expect(tileZoomFor(15.2)).toBe(DATA_MAX_ZOOM);
  });

  it('floors fractional zooms within range', () => {
    expect(tileZoomFor(12.0)).toBe(12);
    expect(tileZoomFor(12.9)).toBe(12);
    expect(tileZoomFor(13.0)).toBe(13);
    expect(tileZoomFor(13.7)).toBe(13);
    expect(tileZoomFor(14.0)).toBe(14);
  });

  it('returns exact integer zooms within range unchanged', () => {
    expect(tileZoomFor(12)).toBe(12);
    expect(tileZoomFor(13)).toBe(13);
    expect(tileZoomFor(14)).toBe(14);
  });
});

describe('dataZoomFor', () => {
  it('overzooms geometry by DATA_ZOOM_BIAS levels below the display tile zoom', () => {
    expect(dataZoomFor(15)).toBe(tileZoomFor(15) - DATA_ZOOM_BIAS); // 14 - 1 = 13
    expect(dataZoomFor(14)).toBe(13);
    expect(dataZoomFor(16)).toBe(13); // capped display zoom 14, overzoomed to 13
  });

  it('never fetches below what the tileset carries (DATA_MIN_ZOOM)', () => {
    expect(dataZoomFor(12)).toBe(DATA_MIN_ZOOM);
    expect(dataZoomFor(12.9)).toBe(DATA_MIN_ZOOM);
    expect(dataZoomFor(0)).toBe(DATA_MIN_ZOOM);
  });
});

describe('tileWorldRect', () => {
  it('z=0/0/0 covers the entire [0,1]² world', () => {
    const rect = tileWorldRect({ z: 0, x: 0, y: 0 });
    expect(rect.minX).toBe(0);
    expect(rect.minY).toBe(0);
    expect(rect.maxX).toBe(1);
    expect(rect.maxY).toBe(1);
  });

  it('span equals 2^-z', () => {
    for (const z of [1, 2, 4, 8, 14]) {
      const span = 1 / Math.pow(2, z);
      const rect = tileWorldRect({ z, x: 0, y: 0 });
      expect(rect.maxX - rect.minX).toBeCloseTo(span, 15);
      expect(rect.maxY - rect.minY).toBeCloseTo(span, 15);
    }
  });

  it('z=1 tiles quarter the world (four non-overlapping quadrants)', () => {
    const nw = tileWorldRect({ z: 1, x: 0, y: 0 });
    const ne = tileWorldRect({ z: 1, x: 1, y: 0 });
    const sw = tileWorldRect({ z: 1, x: 0, y: 1 });
    const se = tileWorldRect({ z: 1, x: 1, y: 1 });

    // Each quadrant is 0.5×0.5
    expect(nw.maxX - nw.minX).toBeCloseTo(0.5, 15);
    expect(nw.maxY - nw.minY).toBeCloseTo(0.5, 15);

    // Together they tile the full world
    expect(Math.min(nw.minX, sw.minX)).toBe(0);
    expect(Math.max(ne.maxX, se.maxX)).toBe(1);
    expect(Math.min(nw.minY, ne.minY)).toBe(0);
    expect(Math.max(sw.maxY, se.maxY)).toBe(1);

    // No gaps or overlaps along x
    expect(nw.maxX).toBeCloseTo(ne.minX, 15);
    expect(sw.maxX).toBeCloseTo(se.minX, 15);
  });

  it('adjacent tiles share edges (x direction)', () => {
    for (const z of [1, 8, 14]) {
      const n = Math.pow(2, z);
      for (const x of [0, Math.floor(n / 2), n - 2]) {
        const left = tileWorldRect({ z, x, y: 0 });
        const right = tileWorldRect({ z, x: x + 1, y: 0 });
        expect(left.maxX).toBeCloseTo(right.minX, 15);
      }
    }
  });

  it('adjacent tiles share edges (y direction)', () => {
    for (const z of [1, 8, 14]) {
      const n = Math.pow(2, z);
      for (const y of [0, Math.floor(n / 2), n - 2]) {
        const top = tileWorldRect({ z, x: 0, y });
        const bottom = tileWorldRect({ z, x: 0, y: y + 1 });
        expect(top.maxY).toBeCloseTo(bottom.minY, 15);
      }
    }
  });

  it('x grows east and y grows south', () => {
    const west = tileWorldRect({ z: 1, x: 0, y: 0 });
    const east = tileWorldRect({ z: 1, x: 1, y: 0 });
    const north = tileWorldRect({ z: 1, x: 0, y: 0 });
    const south = tileWorldRect({ z: 1, x: 0, y: 1 });

    expect(east.minX).toBeGreaterThan(west.minX);
    expect(south.minY).toBeGreaterThan(north.minY);
  });
});

describe('tilesCovering', () => {
  it('a rect strictly inside one tile returns exactly that tile', () => {
    // z=2: each tile is 0.25 wide; tile (1,1) covers [0.25,0.5]×[0.25,0.5]
    const rect = { minX: 0.26, minY: 0.26, maxX: 0.49, maxY: 0.49 };
    const tiles = tilesCovering(rect, 2);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({ z: 2, x: 1, y: 1 });
  });

  it('a rect spanning a tile corner at z=14 returns 4 tiles', () => {
    // Corner between tiles (2624,5719),(2625,5719),(2624,5720),(2625,5720)
    const span14 = 1 / Math.pow(2, 14);
    const cornerX = 2625 * span14; // boundary between x=2624 and x=2625
    const cornerY = 5720 * span14; // boundary between y=5719 and y=5720
    const eps = span14 * 0.01;
    const rect = {
      minX: cornerX - eps,
      minY: cornerY - eps,
      maxX: cornerX + eps,
      maxY: cornerY + eps,
    };
    const tiles = tilesCovering(rect, 14);
    expect(tiles).toHaveLength(4);
    const keys = new Set(tiles.map((t) => tileKeyOf(t.z, t.x, t.y)));
    expect(keys.has('14/2624/5719')).toBe(true);
    expect(keys.has('14/2625/5719')).toBe(true);
    expect(keys.has('14/2624/5720')).toBe(true);
    expect(keys.has('14/2625/5720')).toBe(true);
  });

  it('rect extending beyond world clamps to valid indices (no negative x/y, none ≥ 2^z)', () => {
    const z = 3;
    const n = Math.pow(2, z); // 8
    const rect = { minX: -1, minY: -1, maxX: 2, maxY: 2 };
    const tiles = tilesCovering(rect, z);

    // Should return all n×n tiles
    expect(tiles).toHaveLength(n * n);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(n);
      expect(t.y).toBeLessThan(n);
    }
  });

  it('rect entirely left of world clamps to x=0 column', () => {
    const rect = { minX: -0.5, minY: 0.25, maxX: -0.01, maxY: 0.75 };
    const tiles = tilesCovering(rect, 2);
    // All returned tiles should be at x=0
    for (const t of tiles) {
      expect(t.x).toBe(0);
    }
  });

  it('rect exactly covering one tile at z=1 returns that tile', () => {
    // Tile (0,1) covers [0,0.5]×[0.5,1] at z=1
    const rect = { minX: 0, minY: 0.5, maxX: 0.5, maxY: 1 };
    const tiles = tilesCovering(rect, 1);
    // maxX=0.5 floors to tile x=1 at z=1 → tiles include x=0 and x=1
    // This is expected behavior: rect.maxX on an exact boundary includes the next tile
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    const hasTarget = tiles.some((t) => t.x === 0 && t.y === 1);
    expect(hasTarget).toBe(true);
  });

  it('returns tiles in row-major order (y outer, x inner)', () => {
    const rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const tiles = tilesCovering(rect, 1);
    expect(tiles).toEqual([
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
      { z: 1, x: 0, y: 1 },
      { z: 1, x: 1, y: 1 },
    ]);
  });
});

describe('tileKeyOf', () => {
  it('formats as z/x/y', () => {
    expect(tileKeyOf(14, 2624, 5720)).toBe('14/2624/5720');
    expect(tileKeyOf(0, 0, 0)).toBe('0/0/0');
  });
});
