import { packGeometry } from '../../tiles/packed-geometry';
import { buildFeatureMasks, ROAD_VALUES } from '../masks';
import { worldToScreen } from '../camera';
import { sample } from '../raster';
import type { CameraState, MapGeometry, Viewport } from '../types';

/**
 * Camera chosen so scaleFor(zoom) = 1000 px/world-unit, making the world
 * rectangle [0.45, 0.55]² map exactly to [0, 100]² screen pixels.
 *
 * worldToScreen([wx, wy]) = [(wx − 0.5)·1000 + 50,  (wy − 0.5)·1000 + 50]
 */
const viewport: Viewport = { width: 100, height: 100 };
const zoom = Math.log2(1000 / 256); // scaleFor(zoom) === 1000
const camera: CameraState = { center: [0.5, 0.5], zoom };

function emptyGeo(): MapGeometry {
  return { streets: [], rivers: [], water: [], parks: [], places: [] };
}

/** Project a world point to verify expected screen coordinates in tests. */
function px(wx: number, wy: number): readonly [number, number] {
  return worldToScreen(camera, viewport, [wx, wy]);
}

// ─── streets ─────────────────────────────────────────────────────────────────

describe('streets mask', () => {
  it('roadClass-4 street center pixel equals ROAD_VALUES[4], parks/water stay 0', () => {
    // world [0.45,0.5]→[0.55,0.5] projects to screen (0,50)→(100,50)
    const [, sy] = px(0.5, 0.5); // expect 50
    const geo: MapGeometry = {
      ...emptyGeo(),
      streets: [
        {
          roadClass: 4,
          points: [
            [0.45, 0.5],
            [0.55, 0.5],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);

    expect(sample(masks.streets, 50, sy)).toBe(ROAD_VALUES[4]); // 245
    expect(sample(masks.parks, 50, sy)).toBe(0);
    expect(sample(masks.water, 50, sy)).toBe(0);
  });

  it('omits the smallest road classes (0 and 1) at a zoomed-out (city) camera', () => {
    // This camera's zoom (~1.97) is well below CLASS_MIN_ZOOM for classes 0 (13.5)
    // and 1 (12.0), so the LOD drops them entirely to declutter city-wide views.
    const geo: MapGeometry = {
      ...emptyGeo(),
      streets: [
        {
          roadClass: 0,
          points: [
            [0.45, 0.5],
            [0.55, 0.5],
          ],
        },
        {
          roadClass: 1,
          points: [
            [0.45, 0.52],
            [0.55, 0.52],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);
    expect(masks.streets.data.every((v) => v === 0)).toBe(true);
  });
});

// ─── class layering (max blend) ───────────────────────────────────────────────

describe('streets mask – class layering', () => {
  it('overlapping streets keep the higher class value at the intersection', () => {
    // class 2 (value 205) horizontal + class 3 (value 225) vertical crossing at
    // (50,50). Run at a street-zoom camera so both classes clear CLASS_MIN_ZOOM
    // (2 needs z≥9, 3 needs z≥7); same 100×100 screen window, just a finer world.
    const hiZoom = Math.log2(4_096_000 / 256); // scaleFor ≈ 4.1e6 px/world → z≈14
    const hiCamera: CameraState = { center: [0.5, 0.5], zoom: hiZoom };
    const half = 50 / 4_096_000; // world half-span of the 100 px window
    const geo: MapGeometry = {
      ...emptyGeo(),
      streets: [
        {
          roadClass: 2,
          points: [
            [0.5 - half, 0.5],
            [0.5 + half, 0.5],
          ],
        },
        {
          roadClass: 3,
          points: [
            [0.5, 0.5 - half],
            [0.5, 0.5 + half],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), hiCamera, viewport);
    expect(sample(masks.streets, 50, 50)).toBe(ROAD_VALUES[3]); // 225, not 205
  });
});

// ─── parks mask ───────────────────────────────────────────────────────────────

describe('parks mask', () => {
  it('fills the polygon interior with 255 and leaves the exterior at 0', () => {
    // world [0.48,0.48]→[0.52,0.52] projects to screen (30,30)→(70,70)
    const geo: MapGeometry = {
      ...emptyGeo(),
      parks: [
        {
          rings: [
            [
              [0.48, 0.48],
              [0.52, 0.48],
              [0.52, 0.52],
              [0.48, 0.52],
            ],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);

    const [cx, cy] = px(0.5, 0.5); // (50,50) — inside polygon
    expect(sample(masks.parks, cx, cy)).toBe(255);

    // (10,10) is well outside [30..70]²
    expect(sample(masks.parks, 10, 10)).toBe(0);
  });
});

// ─── water mask (polygon + river) ────────────────────────────────────────────

describe('water mask', () => {
  it('water polygon center reads 255', () => {
    // polygon: world [0.48,0.48]→[0.52,0.52] → screen (30,30)→(70,70)
    const geo: MapGeometry = {
      ...emptyGeo(),
      water: [
        {
          rings: [
            [
              [0.48, 0.48],
              [0.52, 0.48],
              [0.52, 0.52],
              [0.48, 0.52],
            ],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);
    const [cx, cy] = px(0.5, 0.5);
    expect(sample(masks.water, cx, cy)).toBe(255);
  });

  it('river centerline reads 255 and a pixel ~4 px off the centerline reads 0', () => {
    // river at world y=0.47 → screen y=20; RIVER_WIDTH=5 (half=2.5)
    const [, ry] = px(0.5, 0.47); // expect 20
    const geo: MapGeometry = {
      ...emptyGeo(),
      rivers: [
        {
          points: [
            [0.45, 0.47],
            [0.55, 0.47],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);

    expect(sample(masks.water, 50, ry)).toBe(255);

    // 4 px off centerline: cy at ry+4 → distance ≈ 4.5 > half+0.5=3.0 → 0
    expect(sample(masks.water, 50, ry + 4)).toBe(0);
  });

  it('RIVER_WIDTH: a pixel exactly 2 px off the centerline is still inside', () => {
    // half = RIVER_WIDTH/2 = 2.5; distance 2 ≈ 2.5 so still inside
    const [, ry] = px(0.5, 0.47);
    const geo: MapGeometry = {
      ...emptyGeo(),
      rivers: [
        {
          points: [
            [0.45, 0.47],
            [0.55, 0.47],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);
    // 2 px off: cy=ry+2+0.5, distance=2.5, coverage=RIVER_WIDTH/2+0.5−2.5=0.5 → partial > 0
    expect(sample(masks.water, 50, ry + 2)).toBeGreaterThan(0);
  });

  it('water polygon and river polyline both contribute to the water mask', () => {
    // polygon at (50,50), river at y=20 — different locations, both must register
    const geo: MapGeometry = {
      ...emptyGeo(),
      water: [
        {
          rings: [
            [
              [0.48, 0.48],
              [0.52, 0.48],
              [0.52, 0.52],
              [0.48, 0.52],
            ],
          ],
        },
      ],
      rivers: [
        {
          points: [
            [0.45, 0.47],
            [0.55, 0.47],
          ],
        },
      ],
    };
    const masks = buildFeatureMasks(packGeometry(geo), camera, viewport);

    const [cx, cy] = px(0.5, 0.5);
    const [, ry] = px(0.5, 0.47);
    expect(sample(masks.water, cx, cy)).toBe(255); // from polygon
    expect(sample(masks.water, 50, ry)).toBe(255); // from river
  });
});

// ─── empty geometry ───────────────────────────────────────────────────────────

describe('empty geometry', () => {
  it('produces all-zero masks for all three channels', () => {
    const masks = buildFeatureMasks(packGeometry(emptyGeo()), camera, viewport);

    for (const mask of [masks.streets, masks.parks, masks.water]) {
      expect(mask.data.every((v) => v === 0)).toBe(true);
    }
    // spot-check a few coordinates as well
    expect(sample(masks.streets, 50, 50)).toBe(0);
    expect(sample(masks.parks, 50, 50)).toBe(0);
    expect(sample(masks.water, 50, 50)).toBe(0);
  });
});
