import {
  cellRevealOrder,
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
