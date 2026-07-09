import { hash2 } from '../hash';

describe('hash2', () => {
  it('is deterministic', () => {
    expect(hash2(17, 42)).toBe(hash2(17, 42));
    expect(hash2(0.5, 123.25)).toBe(hash2(0.5, 123.25));
  });

  it('stays in [0, 1)', () => {
    for (let i = 0; i < 500; i++) {
      const v = hash2(i * 1.7, i * 3.1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('matches the mock formula at fixed points', () => {
    expect(hash2(0, 0)).toBe(0);
    // frac(sin(x·12.9898 + y·78.233)·43758.5453) computed independently.
    const ref = (x: number, y: number) => {
      const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    expect(hash2(1, 1)).toBe(ref(1, 1));
    expect(hash2(320, 741)).toBe(ref(320, 741));
  });

  it('decorrelates neighboring lattice points', () => {
    expect(Math.abs(hash2(10, 10) - hash2(11, 10))).toBeGreaterThan(0.01);
    expect(Math.abs(hash2(10, 10) - hash2(10, 11))).toBeGreaterThan(0.01);
  });
});
