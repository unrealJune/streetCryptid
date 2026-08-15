import {
  cellRevealOrder,
  hexAxialAt,
  hexCenterOf,
  hexLatticeJitter,
  hexLatticeSizeFor,
  HEX_LOADING_PX,
  proceduralRevealOrder,
  rectUniform,
  revealAlpha,
  revealEmphasis,
  pixelCovered,
  prevRectUniform,
  REVEAL_TARGET,
} from '../reveal-mask';

describe('cellRevealOrder', () => {
  it('rises with the center-out order channel (outer cells reveal later)', () => {
    const inner = cellRevealOrder(0.0, 0.5);
    const mid = cellRevealOrder(0.5, 0.5);
    const outer = cellRevealOrder(1.0, 0.5);
    expect(inner).toBeLessThan(mid);
    expect(mid).toBeLessThan(outer);
  });

  it('stays within [0, 0.9] so the wipe always completes by REVEAL_TARGET', () => {
    for (const b of [0, 0.25, 0.5, 0.75, 1]) {
      for (const g of [0, 0.5, 1]) {
        const order = cellRevealOrder(b, g);
        expect(order).toBeGreaterThanOrEqual(0);
        expect(order).toBeLessThanOrEqual(0.9);
      }
    }
  });

  it('jitters the threshold a little around the base order', () => {
    const base = cellRevealOrder(0.5, 0.5);
    expect(cellRevealOrder(0.5, 1)).toBeGreaterThan(base);
    expect(cellRevealOrder(0.5, 0)).toBeLessThan(base);
  });
});

describe('revealAlpha', () => {
  it('is fully hidden at reveal 0 and fully shown at REVEAL_TARGET', () => {
    for (const b of [0, 0.5, 1]) {
      const order = cellRevealOrder(b, 0.5);
      expect(revealAlpha(order, 0)).toBe(0);
      expect(revealAlpha(order, REVEAL_TARGET)).toBe(1);
    }
  });

  it('is monotonic non-decreasing as the wipe front advances', () => {
    const order = cellRevealOrder(0.6, 0.5);
    let prev = -1;
    for (let r = 0; r <= REVEAL_TARGET + 1e-9; r += 0.05) {
      const a = revealAlpha(order, r);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it('reveals inner cells before outer ones (center-out wipe)', () => {
    const inner = cellRevealOrder(0.1, 0.5);
    const outer = cellRevealOrder(0.9, 0.5);
    // Partway through the wipe, the inner cell is already more revealed.
    const mid = 0.5;
    expect(revealAlpha(inner, mid)).toBeGreaterThan(revealAlpha(outer, mid));
  });

  it('every cell is fully opaque at REVEAL_TARGET (no translucent settle)', () => {
    // Worst case: max order with max jitter push.
    const worst = cellRevealOrder(1, 1);
    expect(revealAlpha(worst, REVEAL_TARGET)).toBe(1);
  });
});

describe('revealEmphasis (the per-hex flash)', () => {
  it('is zero for a hidden or fully-shown hex (no residual brightness at settle)', () => {
    const order = cellRevealOrder(0.5, 0.5);
    expect(revealEmphasis(order, 0)).toBe(0);
    expect(revealEmphasis(order, REVEAL_TARGET)).toBe(0);
  });

  it('peaks while the hex is mid-reveal', () => {
    const order = cellRevealOrder(0.5, 0.5);
    const atHalf = revealAlpha(order, order + 0.06); // ≈ half revealed (band 0.12)
    const emphasisMid = revealEmphasis(order, order + 0.06);
    expect(emphasisMid).toBeGreaterThan(0);
    // The bump is largest near a = 0.5.
    expect(emphasisMid).toBeGreaterThan(revealEmphasis(order, order + 0.11));
    expect(atHalf).toBeGreaterThan(0.4);
    expect(atHalf).toBeLessThan(0.6);
  });

  it('never exceeds 1', () => {
    const order = cellRevealOrder(0.3, 0.7);
    for (let r = 0; r <= REVEAL_TARGET + 1e-9; r += 0.02) {
      expect(revealEmphasis(order, r)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('pixelCovered (the previously-rendered mask)', () => {
  const prev = { x: 10, y: 20, width: 100, height: 50 };

  it('is true inside the previous rect (instant swap, no reveal there)', () => {
    expect(pixelCovered(50, 40, prev)).toBe(true);
    expect(pixelCovered(10, 20, prev)).toBe(true); // corner inclusive
    expect(pixelCovered(110, 70, prev)).toBe(true); // opposite corner inclusive
  });

  it('is false outside the previous rect (that ground hex-loads in)', () => {
    expect(pixelCovered(5, 40, prev)).toBe(false);
    expect(pixelCovered(50, 80, prev)).toBe(false);
  });

  it('covers nothing when there is no previous layer (first load reveals all)', () => {
    expect(pixelCovered(50, 40, null)).toBe(false);
    expect(pixelCovered(50, 40, { x: 0, y: 0, width: 0, height: 0 })).toBe(false);
  });
});

describe('prevRectUniform', () => {
  it('packs a rect into the shader float4', () => {
    expect(prevRectUniform({ x: 1, y: 2, width: 3, height: 4 })).toEqual([1, 2, 3, 4]);
  });

  it('encodes "no previous layer" as a zero-width rect the shader ignores', () => {
    expect(prevRectUniform(null)).toEqual([0, 0, 0, 0]);
  });
});

describe('rectUniform', () => {
  it('packs a rect into the shader float4', () => {
    expect(rectUniform({ x: 5, y: 6, width: 7, height: 8 })).toEqual([5, 6, 7, 8]);
  });

  it('encodes null as a zero rect', () => {
    expect(rectUniform(null)).toEqual([0, 0, 0, 0]);
  });
});

describe('hexLatticeSizeFor', () => {
  it('is off when the region baked real exploration cells (texture wins)', () => {
    expect(hexLatticeSizeFor(true, 1)).toBe(0);
    expect(hexLatticeSizeFor(true, 40)).toBe(0);
  });

  it('is on when the region has no cells — the city-and-out case', () => {
    expect(hexLatticeSizeFor(false, 1)).toBeGreaterThan(0);
  });

  it('holds a constant SCREEN size as the view scales away from the anchor', () => {
    // The reveal draws in anchor space and the canvas group scales it by k, so
    // the uniform must divide by k for the on-screen hexes to stay put.
    for (const k of [0.05, 0.5, 1, 8, 64]) {
      expect(hexLatticeSizeFor(false, k) * k).toBeCloseTo(HEX_LOADING_PX, 6);
    }
  });

  it('does not divide by zero at a degenerate scale', () => {
    expect(Number.isFinite(hexLatticeSizeFor(false, 0))).toBe(true);
  });
});

describe('hex lattice', () => {
  const SIZE = HEX_LOADING_PX;

  it('round-trips a hex center back to its own axial index', () => {
    for (const axial of [
      [0, 0],
      [3, -2],
      [-4, 7],
      [11, 5],
    ] as [number, number][]) {
      const [cx, cy] = hexCenterOf(axial, SIZE);
      expect(hexAxialAt(cx, cy, SIZE)).toEqual(axial);
    }
  });

  it('assigns every point to the nearest hex center (a real tiling, no gaps)', () => {
    // Sample a patch; each point's own hex must be the closest of all candidates.
    for (let x = 0; x < 200; x += 7) {
      for (let y = 0; y < 200; y += 7) {
        const mine = hexAxialAt(x, y, SIZE);
        const [mx, my] = hexCenterOf(mine, SIZE);
        const mineDist = Math.hypot(x - mx, y - my);
        for (let dq = -2; dq <= 2; dq++) {
          for (let dr = -2; dr <= 2; dr++) {
            const [ox, oy] = hexCenterOf([mine[0] + dq, mine[1] + dr], SIZE);
            expect(mineDist).toBeLessThanOrEqual(Math.hypot(x - ox, y - oy) + 1e-9);
          }
        }
      }
    }
  });

  it('keeps neighbouring points in the same cell (hexes are solid, not per-pixel noise)', () => {
    const [cx, cy] = hexCenterOf([2, 3], SIZE);
    const at = hexAxialAt(cx, cy, SIZE);
    // A small step from the center stays inside the same hex.
    expect(hexAxialAt(cx + 2, cy, SIZE)).toEqual(at);
    expect(hexAxialAt(cx, cy + 2, SIZE)).toEqual(at);
  });

  it('hashes each hex to a stable value in [0, 1)', () => {
    const seen = new Set<number>();
    for (let q = -6; q <= 6; q++) {
      for (let r = -6; r <= 6; r++) {
        const j = hexLatticeJitter([q, r]);
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThan(1);
        expect(hexLatticeJitter([q, r])).toBe(j); // stable
        seen.add(j);
      }
    }
    // Distinct enough to actually stagger the wipe.
    expect(seen.size).toBeGreaterThan(150);
  });
});

describe('proceduralRevealOrder (regions with no baked cell field)', () => {
  const region = { x: 0, y: 0, width: 390, height: 844 };
  const SIZE = HEX_LOADING_PX;

  it('reveals center-out, like the baked order channel', () => {
    const middle = proceduralRevealOrder(region.width / 2, region.height / 2, region, SIZE);
    const corner = proceduralRevealOrder(2, 2, region, SIZE);
    expect(middle).toBeLessThan(corner);
  });

  it('stays within [0, 0.9] so the wipe still completes by REVEAL_TARGET', () => {
    for (let x = 0; x < region.width; x += 13) {
      for (let y = 0; y < region.height; y += 29) {
        const order = proceduralRevealOrder(x, y, region, SIZE);
        expect(order).toBeGreaterThanOrEqual(0);
        expect(order).toBeLessThanOrEqual(0.9);
        expect(revealAlpha(order, REVEAL_TARGET)).toBe(1);
      }
    }
  });

  it('honours the region origin (the lattice is anchored to the rect, not the canvas)', () => {
    const shifted = { x: 100, y: 250, width: 390, height: 844 };
    expect(proceduralRevealOrder(100 + 40, 250 + 40, shifted, SIZE)).toBeCloseTo(
      proceduralRevealOrder(40, 40, region, SIZE),
      12
    );
  });

  /**
   * The bug this replaced: below the exploration render cutoff the engine builds
   * an EMPTY cell field, so the baked texture is flat black — order channel 0 and
   * jitter channel 0 for every pixel. Read through `cellRevealOrder` that is one
   * threshold of exactly 0 for the whole region, so the entire thing crossed the
   * 0.12 smoothstep band together: a single hard pop ~12% into the wipe, with no
   * hexagons at all. City-and-out zooms are exactly where cold loads are slowest.
   */
  it('gives many distinct thresholds where the flat black texture gave exactly one', () => {
    const baked = new Set<number>();
    const procedural = new Set<number>();
    for (let x = 0; x < region.width; x += 5) {
      for (let y = 0; y < region.height; y += 5) {
        baked.add(cellRevealOrder(0, 0)); // what an empty cell field bakes
        procedural.add(proceduralRevealOrder(x, y, region, SIZE));
      }
    }
    expect(baked.size).toBe(1);
    expect([...baked][0]).toBe(0); // → smoothstep(0, 0.12, uReveal): one hard pop
    expect(procedural.size).toBeGreaterThan(200);
  });

  it('actually animates: coverage grows steadily instead of popping in at once', () => {
    const coverageAt = (front: number) => {
      let lit = 0;
      let total = 0;
      for (let x = 0; x < region.width; x += 5) {
        for (let y = 0; y < region.height; y += 5) {
          total++;
          if (revealAlpha(proceduralRevealOrder(x, y, region, SIZE), front) > 0.5) lit++;
        }
      }
      return lit / total;
    };
    const steps = [0.1, 0.3, 0.5, 0.7, 0.9].map(coverageAt);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
    expect(steps[0]).toBeLessThan(0.2); // still mostly empty early
    expect(steps[steps.length - 1]).toBeGreaterThan(0.8); // nearly full late
    // The old path had none of this — it was fully lit by 0.12.
    expect(revealAlpha(cellRevealOrder(0, 0), 0.12)).toBe(1);
  });
});
