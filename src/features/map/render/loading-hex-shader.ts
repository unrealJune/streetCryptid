export const LOADING_HEX_SKSL = `
uniform float2 uSize;
uniform float uScale;
uniform float uPhase;
uniform float3 uInk;

half4 main(float2 pos) {
  float2 p = pos * uScale;
  float radius = 28.0;
  float2 period = float2(1.7320508 * radius, 3.0 * radius);
  float2 a = mod(p, period) - period * 0.5;
  float2 b = mod(p - period * 0.5, period) - period * 0.5;
  float2 q = dot(a, a) < dot(b, b) ? a : b;
  float edge = 0.8660254 * radius -
    max(abs(q.x), dot(abs(q), float2(0.5, 0.8660254)));
  float outline = 1.0 - smoothstep(0.5, 1.5, edge);
  float sweep = (pos.x + pos.y * 0.35) / max(1.0, uSize.x + uSize.y * 0.35);
  float band = 1.0 - smoothstep(0.0, 0.22, abs(sweep - (uPhase * 1.5 - 0.25)));
  float alpha = outline * (0.10 + 0.17 * band) + 0.025 * band;
  return half4(uInk * alpha, alpha);
}
`;
