import { hexClipInner, hexClipUniforms } from '../hex-clip';

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
