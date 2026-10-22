import { clipLatticeFor, hexClipInner, hexClipUniforms } from '../hex-clip';

const lattice = { originX: 10, originY: -4, radius: 20, rotation: 0.3, strokeWidth: 0.8 };
const rect = { x: 100, y: 200, width: 400, height: 900 };

describe('hexClipInner', () => {
  // A dropped cell's centre is within one radius of the edge and its pixels reach one more, so
  // anything closer than two radii to the edge may be cut; the inner rect must stay clear of it.
  it('stays more than two cell radii inside the rect', () => {
    const inner = hexClipInner(rect, lattice)!;
    expect(inner.x - rect.x).toBeGreaterThan(2 * lattice.radius);
    expect(inner.y - rect.y).toBeGreaterThan(2 * lattice.radius);
    expect(rect.x + rect.width - (inner.x + inner.width)).toBeCloseTo(inner.x - rect.x);
    expect(rect.y + rect.height - (inner.y + inner.height)).toBeCloseTo(inner.y - rect.y);
  });

  it('has no interior when the rect is only a few cells across', () => {
    expect(hexClipInner({ x: 0, y: 0, width: 80, height: 900 }, lattice)).toBeNull();
  });
});

describe('clipLatticeFor', () => {
  // The region pads its build view by one view per side (`padFor` at street zoom).
  const region = { x: 0, y: 0, width: 1200, height: 2400 };
  const view = { x: 400, y: 800, width: 400, height: 800 };

  it('keeps the clip while every cell touching the view fits inside the rect', () => {
    expect(clipLatticeFor(region, view, lattice)).toBe(lattice);
    expect(clipLatticeFor(region, view, { ...lattice, radius: 200 })).not.toBeNull();
  });

  // Zoomed far in a cell is wider than the pad: the clip would drop cells that are on screen.
  it('turns the clip off once a cell is wider than the pad', () => {
    expect(clipLatticeFor(region, view, { ...lattice, radius: 201 })).toBeNull();
  });

  it('measures the narrowest side of the pad', () => {
    const offCentre = { ...view, x: 700 };
    expect(clipLatticeFor(region, offCentre, { ...lattice, radius: 60 })).toBeNull();
  });

  it('passes no lattice through', () => {
    expect(clipLatticeFor(region, view, null)).toBeNull();
  });
});

describe('hexClipUniforms', () => {
  it('passes the lattice and the rect, all in anchor space', () => {
    expect(hexClipUniforms(rect, lattice)).toEqual({
      uHexOrigin: [10, -4],
      uHexRadius: 20,
      uHexRot: [Math.cos(0.3), Math.sin(0.3)],
      uHexRect: [100, 200, 400, 900],
      uHexAA: 0.8,
    });
  });

  // No lattice (exploration off): the reveal shader still runs, and must keep every pixel.
  it('turns the clip off without a lattice', () => {
    expect(hexClipUniforms(rect, null).uHexRadius).toBe(0);
  });
});
