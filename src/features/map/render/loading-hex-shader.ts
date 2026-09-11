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
 */
export const LOADING_HEX_SKSL = `
uniform float2 uOrigin;   // reference cell centre, in this shader's coordinate space
uniform float  uRadius;   // centre-to-vertex, same space
uniform float  uRot;      // lattice rotation, radians
uniform float  uWidth;    // outline width, same space
uniform float  uPhase;    // sweep position, 0..1
uniform float  uSweep;    // 0 = settled lattice, 1 = a band travelling across it
uniform float3 uInk;

const float SQRT3 = 1.7320508;
const float HALF_SQRT3 = 0.8660254;
/** Sweep wavelength in cell radii — a wave measured in hexes reads the same at every zoom. */
const float WAVE = 26.0;
/** Resting outline alpha, and how much brighter the sweep's crest gets. */
const float BASE_ALPHA = 0.10;
const float CREST_ALPHA = 0.17;

half4 main(float2 pos) {
  float2 d = pos - uOrigin;
  // Into lattice space: undo the measured rotation, so the canonical tiling below lands on the
  // real cells rather than 30-odd degrees off them.
  float c = cos(uRot);
  float s = sin(uRot);
  float2 p = float2(d.x * c + d.y * s, -d.x * s + d.y * c);

  // Two interleaved rectangular lattices make one triangular lattice of cell centres; p = 0 is a
  // centre of the second, which is what pins the tiling to the cell we measured.
  float2 period = float2(SQRT3 * uRadius, 3.0 * uRadius);
  float2 a = mod(p, period) - period * 0.5;
  float2 b = mod(p - period * 0.5, period) - period * 0.5;
  float2 q = dot(a, a) < dot(b, b) ? a : b;

  // Distance inside the hexagon from its boundary; faces at 0°, ±60°, 180°, ±120°.
  float edge = HALF_SQRT3 * uRadius - max(abs(q.x), dot(abs(q), float2(0.5, HALF_SQRT3)));
  float outline = 1.0 - smoothstep(uWidth * 0.5, uWidth * 1.5, edge);

  float wave = (p.x * 0.94 + p.y * 0.34) / max(1.0, WAVE * uRadius);
  float band = pow(0.5 + 0.5 * cos(6.2831853 * (wave - uPhase)), 6.0) * uSweep;
  float alpha = outline * (BASE_ALPHA + CREST_ALPHA * band) + 0.02 * band;
  return half4(uInk * alpha, alpha);
}
`;
