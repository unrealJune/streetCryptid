/**
 * Deterministic pseudo-random hash of a 2D lattice point, port of the mock's
 * `hash()` (the classic GLSL sin-fract one-liner). Drives per-dot dropout and
 * value jitter so the dot field looks organic but rebuilds byte-identically.
 */
export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
