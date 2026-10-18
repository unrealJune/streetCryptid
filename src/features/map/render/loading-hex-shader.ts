/**
 * The loading skeleton's hex lattice.
 *
 * Coordinates are ANCHOR SPACE, not screen space: the shader is drawn inside the same transformed
 * Group as the region bitmaps, so leaving `pos` alone makes the lattice pan and zoom with the map
 * exactly as the baked ghost lattice does. The previous version multiplied `pos` by the live scale
 * to hold the hexes at a fixed 28 screen px, which is why they slid through the map as you pinched
 * and bore no relation to the H3 cells they were standing in for.
 *
 * Geometry comes in from `core/hex-lattice.ts`, measured off a real H3 cell.
 *
 * The animation is decided PER CELL, not per pixel: every pixel works out which hexagon it is in
 * and times its light off that hexagon's centre, so cells light up whole, the way the H3 cells the
 * map is loading arrive. (The first version ran a smooth diagonal band through the outlines, plus a
 * faint glow over everything — a shimmer laid on the grid rather than the grid doing anything.)
 * See {@link LOADING_PATTERNS} for what each `uMode` does.
 */

/** The loading animations, by `uMode`. */
export const LOADING_PATTERNS = {
  /** Rings of cells travel outward from the middle of the view, where loading starts. */
  radial: 0,
  /** Cells light at random, each on its own clock — a field of cells arriving. */
  twinkle: 1,
  /** One arm sweeps around the middle of the view and outward, like a radar. */
  spiral: 2,
  /** The original diagonal sweep, quantized to whole cells. */
  scan: 3,
} as const;

export type LoadingPattern = keyof typeof LOADING_PATTERNS;

export const LOADING_HEX_SKSL = `
uniform float2 uOrigin;   // reference cell centre, in this shader's coordinate space
uniform float  uRadius;   // centre-to-vertex, same space
uniform float  uRot;      // lattice rotation, radians
uniform float  uWidth;    // outline width, same space
uniform float  uPhase;    // animation position, 0..1, repeating
uniform float  uSweep;    // 0 = settled lattice, 1 = animating at full strength
uniform float2 uCenter;   // where loading starts (the middle of the view), same space
uniform float  uMode;     // LOADING_PATTERNS
uniform float3 uInk;

const float SQRT3 = 1.7320508;
const float HALF_SQRT3 = 0.8660254;
const float TAU = 6.2831853;
/** Distance between successive rings / arm turns, in cell radii: reads the same at every zoom. */
const float WAVE = 18.0;
/** Resting outline alpha; how much brighter a lit cell's outline gets; how much a lit cell fills. */
const float BASE_ALPHA = 0.10;
const float CREST_ALPHA = 0.20;
const float FILL_ALPHA = 0.07;

float2 toLattice(float2 v, float c, float s) { return float2(v.x * c + v.y * s, -v.x * s + v.y * c); }

half4 main(float2 pos) {
  // Into lattice space: undo the measured rotation, so the canonical tiling below lands on the
  // real cells rather than 30-odd degrees off them.
  float c = cos(uRot);
  float s = sin(uRot);
  float2 p = toLattice(pos - uOrigin, c, s);

  // Two interleaved rectangular lattices make one triangular lattice of cell centres; p = 0 is a
  // centre of the second, which is what pins the tiling to the cell we measured.
  float2 period = float2(SQRT3 * uRadius, 3.0 * uRadius);
  float2 a = mod(p, period) - period * 0.5;
  float2 b = mod(p - period * 0.5, period) - period * 0.5;
  float2 q = dot(a, a) < dot(b, b) ? a : b;

  // Distance inside the hexagon from its boundary; faces at 0°, ±60°, 180°, ±120°.
  float edge = HALF_SQRT3 * uRadius - max(abs(q.x), dot(abs(q), float2(0.5, HALF_SQRT3)));
  float outline = 1.0 - smoothstep(uWidth * 0.5, uWidth * 1.5, edge);

  // A settled lattice pays for none of the animation. The test is on a uniform, so every pixel of
  // a draw takes the same branch.
  if (uSweep <= 0.0) {
    float rest = outline * BASE_ALPHA;
    return half4(uInk * rest, rest);
  }

  // Everything below is a function of the CELL: its centre, in radii from where loading starts.
  float2 cell = p - q;
  float2 rel = (cell - toLattice(uCenter - uOrigin, c, s)) / uRadius;
  float dist = length(rel);
  float2 key = floor(cell / uRadius + 0.5);
  float n = fract(sin(dot(key, float2(127.1, 311.7))) * 43758.5453 + key.x * 0.618034);

  float t;
  float sharp = 8.0;
  if (uMode < 0.5) {
    // A little per-cell jitter keeps the rings from reading as perfect circles of hexes.
    t = (dist + n * 0.8) / WAVE - uPhase;
  } else if (uMode < 1.5) {
    t = n - uPhase;
    sharp = 24.0;
  } else if (uMode < 2.5) {
    t = atan(rel.y, rel.x) / TAU + dist / (WAVE * 2.0) - uPhase;
  } else {
    t = (rel.x * 0.94 + rel.y * 0.34) / WAVE - uPhase;
  }
  float lit = pow(0.5 + 0.5 * cos(TAU * t), sharp) * uSweep;
  float inside = smoothstep(0.0, uWidth * 1.5, edge);
  float alpha = outline * (BASE_ALPHA + CREST_ALPHA * lit) + inside * FILL_ALPHA * lit;
  return half4(uInk * alpha, alpha);
}
`;
