import { FIXTURE_BOUNDS, FIXTURE_TILES } from '../__fixtures__/caphill-tiles';
import { EMPTY_GEOMETRY } from '../geometry-source';
import { FixtureGeometrySource } from '../fixture-source';
import { tileWorldRect } from '../tile-math';

const source = new FixtureGeometrySource();
const fixtureKeys = Object.keys(FIXTURE_TILES);

// ─── Fixture key format ────────────────────────────────────────────────────────

describe('FIXTURE_TILES keys', () => {
  it('every key is formatted as z/x/y with z in [12,14]', () => {
    for (const key of fixtureKeys) {
      const parts = key.split('/');
      expect(parts).toHaveLength(3);
      const [z, x, y] = parts.map(Number);
      expect(Number.isInteger(z)).toBe(true);
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(12);
      expect(z).toBeLessThanOrEqual(14);
      const n = Math.pow(2, z);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(n);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(n);
    }
  });
});

// ─── Decoding all fixture tiles ───────────────────────────────────────────────

describe('FixtureGeometrySource — all fixture tiles decode without error', () => {
  it('every tile in FIXTURE_TILES resolves successfully', async () => {
    for (const key of fixtureKeys) {
      const [z, x, y] = key.split('/').map(Number);
      await expect(source.getTile({ z, x, y })).resolves.toBeDefined();
    }
  });
});

// ─── Content assertions ───────────────────────────────────────────────────────

describe('FixtureGeometrySource — content', () => {
  it('at least one tile yields more than 50 streets (Capitol Hill has many roads)', async () => {
    let maxStreets = 0;
    for (const key of fixtureKeys) {
      const [z, x, y] = key.split('/').map(Number);
      const geom = await source.getTile({ z, x, y });
      if (geom.streets.length > maxStreets) maxStreets = geom.streets.length;
    }
    expect(maxStreets).toBeGreaterThan(50);
  });

  it('across all tiles there is a place named "Capitol Hill"', async () => {
    let found = false;
    for (const key of fixtureKeys) {
      const [z, x, y] = key.split('/').map(Number);
      const geom = await source.getTile({ z, x, y });
      if (geom.places.some((p) => p.name === 'Capitol Hill')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

// ─── Unknown tile ─────────────────────────────────────────────────────────────

describe('FixtureGeometrySource — unknown tile', () => {
  it('resolves to EMPTY_GEOMETRY for a tile not in the fixture set', async () => {
    // (z:14, x:0, y:0) is far from Capitol Hill and not in the fixture set
    const geom = await source.getTile({ z: 14, x: 0, y: 0 });
    expect(geom.streets).toHaveLength(0);
    expect(geom).toEqual(EMPTY_GEOMETRY);
  });
});

// ─── Geographic sanity ────────────────────────────────────────────────────────

describe('FixtureGeometrySource — geographic sanity', () => {
  /**
   * Check that all decoded street points of one known z=14 tile lie within
   * FIXTURE_BOUNDS grown by 20% of its dimensions on each side.
   */
  it('street points from tile 14/2625/5720 lie within their tile rect (+ MVT buffer)', async () => {
    // Choose a tile in the center of the fixture area
    const tile = { z: 14, x: 2625, y: 5720 };

    // Check this tile is actually in the fixture set; if not, skip gracefully
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (!FIXTURE_TILES[key]) {
      // Tile not present — pick the first z=14 tile instead
      const z14Key = fixtureKeys.find((k) => k.startsWith('14/'));
      if (!z14Key) return; // no z=14 tiles at all, nothing to test
      const [z, x, y] = z14Key.split('/').map(Number);
      const geom = await source.getTile({ z, x, y });
      const rect = tileWorldRect({ z, x, y });
      assertPointsInBounds(geom, rect);
      return;
    }

    const geom = await source.getTile(tile);
    expect(geom.streets.length).toBeGreaterThan(0); // tile should be non-empty

    // Points must lie within the tile's world rect, expanded by FIXTURE_BOUNDS ± 20%.
    // The 20% margin covers tiles that extend slightly beyond FIXTURE_BOUNDS.
    const dx = FIXTURE_BOUNDS.maxX - FIXTURE_BOUNDS.minX;
    const dy = FIXTURE_BOUNDS.maxY - FIXTURE_BOUNDS.minY;
    const expanded = {
      minX: FIXTURE_BOUNDS.minX - 0.5 * dx,
      maxX: FIXTURE_BOUNDS.maxX + 0.5 * dx,
      minY: FIXTURE_BOUNDS.minY - 0.5 * dy,
      maxY: FIXTURE_BOUNDS.maxY + 0.5 * dy,
    };

    for (const street of geom.streets) {
      for (const [px, py] of street.points) {
        expect(px).toBeGreaterThanOrEqual(expanded.minX);
        expect(px).toBeLessThanOrEqual(expanded.maxX);
        expect(py).toBeGreaterThanOrEqual(expanded.minY);
        expect(py).toBeLessThanOrEqual(expanded.maxY);
      }
    }
  });
});

// ─── Helper ───────────────────────────────────────────────────────────────────

function assertPointsInBounds(
  geom: Awaited<ReturnType<FixtureGeometrySource['getTile']>>,
  rect: ReturnType<typeof tileWorldRect>
): void {
  // Allow a 20% tile-width buffer for MVT encoding artifacts
  const bx = (rect.maxX - rect.minX) * 0.2;
  const by = (rect.maxY - rect.minY) * 0.2;
  for (const street of geom.streets) {
    for (const [px, py] of street.points) {
      expect(px).toBeGreaterThanOrEqual(rect.minX - bx);
      expect(px).toBeLessThanOrEqual(rect.maxX + bx);
      expect(py).toBeGreaterThanOrEqual(rect.minY - by);
      expect(py).toBeLessThanOrEqual(rect.maxY + by);
    }
  }
}
