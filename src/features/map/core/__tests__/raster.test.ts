import { sample, sampleMax5, softwareRasterizer } from '../raster';
import type { MutableMask } from '../raster';

const { createMask, strokePolyline, fillPolygonEvenOdd } = softwareRasterizer;

function blank(w: number, h: number): MutableMask {
  return createMask({ width: w, height: h });
}

// ─── createMask ───────────────────────────────────────────────────────────────

describe('createMask', () => {
  it('returns correct dimensions and a fully-zeroed buffer', () => {
    const m = createMask({ width: 64, height: 64 });
    expect(m.width).toBe(64);
    expect(m.height).toBe(64);
    expect(m.data.length).toBe(64 * 64);
    expect(m.data.every((v) => v === 0)).toBe(true);
  });

  it('rounds fractional sizes to the nearest integer', () => {
    const m = createMask({ width: 32.7, height: 16.3 });
    expect(m.width).toBe(33);
    expect(m.height).toBe(16);
    expect(m.data.length).toBe(33 * 16);
  });

  it('enforces a minimum size of 1×1', () => {
    const m = createMask({ width: 0, height: 0 });
    expect(m.width).toBe(1);
    expect(m.height).toBe(1);
    expect(m.data.length).toBe(1);
  });
});

// ─── strokePolyline – horizontal stroke ───────────────────────────────────────

describe('strokePolyline – horizontal line [(10,32)→(54,32)] width 6 value 200', () => {
  let mask: MutableMask;

  beforeEach(() => {
    mask = blank(64, 64);
    strokePolyline(
      mask,
      [
        [10, 32],
        [54, 32],
      ],
      6,
      200
    );
  });

  it('center-line pixel equals the stroke value', () => {
    // pixel (32,32): cell center cy=32.5, distance to y=32 is 0.5 → full coverage
    expect(sample(mask, 32, 32)).toBe(200);
  });

  it('pixel 2 px perpendicular off-center is still full value', () => {
    // pixel (32,30): cy=30.5, distance=1.5, coverage=2.0 → full
    expect(sample(mask, 32, 30)).toBe(200);
  });

  it('pixel 5+ px off-center is zero', () => {
    // pixel (32,27): cy=27.5, distance=4.5, coverage=-1.0 → 0
    expect(sample(mask, 32, 27)).toBe(0);
  });

  it('pixel near the stroke edge has an antialiased (partial) value', () => {
    // pixel (56,30) lies in the round cap beyond endpoint B=(54,32):
    // distance = sqrt(2.5²+1.5²) ≈ 2.92, coverage ≈ 0.58 → v ≈ 117
    const v = sample(mask, 56, 30);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(200);
  });
});

// ─── strokePolyline – round end caps ──────────────────────────────────────────

describe('strokePolyline – round end caps', () => {
  it('covers a pixel ~2 px beyond the endpoint along the stroke direction', () => {
    const mask = blank(64, 64);
    strokePolyline(
      mask,
      [
        [10, 32],
        [54, 32],
      ],
      6,
      200
    );
    // pixel (56,32): 2 px past endpoint B=(54,32); inside the round cap disc
    // distance = sqrt(2.5²+0.5²) ≈ 2.55, coverage ≈ 0.95 → v=190 > 0
    expect(sample(mask, 56, 32)).toBeGreaterThan(0);
  });
});

// ─── strokePolyline – max() blend ─────────────────────────────────────────────

describe('strokePolyline – max() blend', () => {
  it('intersection pixel keeps the higher value when low-value stroke comes first', () => {
    const mask = blank(64, 64);
    strokePolyline(
      mask,
      [
        [10, 32],
        [54, 32],
      ],
      6,
      128
    ); // horizontal, dim
    strokePolyline(
      mask,
      [
        [32, 10],
        [32, 54],
      ],
      6,
      245
    ); // vertical, bright
    expect(sample(mask, 32, 32)).toBe(245);
  });

  it('max() blend is order-independent (bright stroke drawn first)', () => {
    const mask = blank(64, 64);
    strokePolyline(
      mask,
      [
        [32, 10],
        [32, 54],
      ],
      6,
      245
    ); // bright first
    strokePolyline(
      mask,
      [
        [10, 32],
        [54, 32],
      ],
      6,
      128
    ); // dim second
    expect(sample(mask, 32, 32)).toBe(245);
  });
});

// ─── strokePolyline – single-point polyline ───────────────────────────────────

describe('strokePolyline – single-point polyline', () => {
  it('stamps a disc centered on the lone point', () => {
    const mask = blank(64, 64);
    strokePolyline(mask, [[30, 30]], 6, 180);
    // degenerate segment a=b: dist from center of pixel (30,30) to point is sqrt(0.5²+0.5²)≈0.71
    expect(sample(mask, 30, 30)).toBeGreaterThan(0);
    // pixel far away is untouched
    expect(sample(mask, 0, 0)).toBe(0);
  });
});

// ─── fillPolygonEvenOdd ───────────────────────────────────────────────────────

describe('fillPolygonEvenOdd', () => {
  it('fills interior pixels and leaves exterior pixels empty', () => {
    const mask = blank(64, 64);
    fillPolygonEvenOdd(
      mask,
      [
        [
          [8, 8],
          [40, 8],
          [40, 40],
          [8, 40],
        ],
      ],
      255
    );
    expect(sample(mask, 24, 24)).toBe(255); // interior
    expect(sample(mask, 50, 50)).toBe(0); // outside polygon bounds
  });

  it('applies even-odd rule: hole interior is 0, ring band is 255', () => {
    // outer ring [(8,8)..(40,40)], hole [(16,16)..(32,32)]
    // scanY=24.5 produces xs=[8,16,32,40] → pairs [8..15] and [32..39] filled
    const mask = blank(64, 64);
    fillPolygonEvenOdd(
      mask,
      [
        [
          [8, 8],
          [40, 8],
          [40, 40],
          [8, 40],
        ],
        [
          [16, 16],
          [32, 16],
          [32, 32],
          [16, 32],
        ],
      ],
      255
    );
    expect(sample(mask, 24, 24)).toBe(0); // inside the hole (even-odd winding = 2)
    expect(sample(mask, 12, 24)).toBe(255); // in the ring band (winding = 1)
  });

  it('empty rings array does nothing and does not throw', () => {
    const mask = blank(64, 64);
    expect(() => fillPolygonEvenOdd(mask, [], 255)).not.toThrow();
    expect(mask.data.every((v) => v === 0)).toBe(true);
  });

  it('polygon fully outside mask bounds does not throw and leaves mask zeroed', () => {
    const mask = blank(64, 64);
    expect(() =>
      fillPolygonEvenOdd(
        mask,
        [
          [
            [200, 200],
            [300, 200],
            [300, 300],
            [200, 300],
          ],
        ],
        255
      )
    ).not.toThrow();
    expect(mask.data.every((v) => v === 0)).toBe(true);
  });
});

// ─── sample ──────────────────────────────────────────────────────────────────

describe('sample', () => {
  it('clamps out-of-bounds coordinates to edge pixels without throwing', () => {
    const mask = blank(64, 64);
    mask.data[0] = 50; // top-left corner pixel
    mask.data[63 * 64 + 63] = 77; // bottom-right corner pixel

    // negative coordinates clamp to (0,0)
    expect(sample(mask, -10, -10)).toBe(50);
    // large positive coordinates clamp to (63,63)
    expect(sample(mask, 200, 200)).toBe(77);
  });
});

// ─── sampleMax5 ───────────────────────────────────────────────────────────────

describe('sampleMax5', () => {
  it('catches a lit pixel that plain sample misses due to sub-pixel offset', () => {
    const mask = blank(64, 64);
    mask.data[30 * 64 + 30] = 255; // only pixel (30,30) is lit

    // plain sample: Math.round(31.2)=31 → reads pixel at x=31 → 0
    expect(sample(mask, 31.2, 30)).toBe(0);

    // sampleMax5 with step=2: offset o=0.8; x−o=30.4→Math.round=30 → 255
    expect(sampleMax5(mask, 31.2, 30, 2)).toBe(255);
  });
});
