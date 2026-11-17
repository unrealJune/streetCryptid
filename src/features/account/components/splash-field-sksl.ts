/**
 * The splash's lattice: the pairing field's dot instrument stretched over the whole screen.
 *
 * Friends ping in from the edges (`uF0..uF3`: origin, start, reach), each ring lighting the
 * dots it passes in the default friend signal and leaving them to cool; once they meet at the
 * sigil, YOU answers in amber (`uYou`). The lattice then clears an ellipse around the sigil and
 * wordmark (`uClear`) so the mark reads on a quiet ground, and after the intro each friend keeps
 * softly checking in.
 *
 * The trail is analytic rather than a feedback buffer: a dot a ring passed `since` seconds ago
 * glows `0.7 * exp(-since * 3.6)` behind the brighter leading band, so
 * the shader stays stateless and a reduced-motion frame is just `uStill = 1`.
 */
export const SPLASH_FIELD_SKSL = `
uniform float2 uSize;
uniform float uTime;
uniform float uStill;
uniform float4 uF0;
uniform float4 uF1;
uniform float4 uF2;
uniform float4 uF3;
uniform float uSpeed;
uniform float2 uYou;
uniform float uYouSpeed;
uniform float uYouReach;
uniform float2 uStarts; // x: the amber reply leaves, y: the lattice clears
uniform float4 uClear;
uniform float3 uBase;
uniform float3 uSignal;
uniform float3 uAmber;
uniform float3 uGround;
uniform float uBaseA;

const float STEP = 15.0;

float easeOut(float p) {
  if (p <= 0.0) return 0.0;
  if (p >= 1.0) return 1.0;
  return 1.0 - pow(2.0, -10.0 * p);
}

// One ring from an origin \`d\` points away: its leading band, then the cooling trail behind it.
float ring(float d, float age, float speed, float width, float reach, float k) {
  if (age <= 0.0 || d > reach) return 0.0;
  float lead = max(0.0, 1.0 - abs(d - age * speed) / width);
  float since = age - d / speed;
  float trail = since > 0.0 ? 0.7 * exp(-since * 3.6) : 0.0;
  return max(lead, trail) * (1.0 - d / reach) * k;
}

float friendHeat(float4 f, float2 cell, float index) {
  if (f.w <= 0.0) return 0.0;
  float d = length(cell - f.xy);
  float age = uTime - f.z;
  float heat = ring(d, age, uSpeed, 22.0, f.w, 1.0);
  heat = max(heat, ring(d, age - 0.3, uSpeed, 16.0, f.w * 0.8, 0.4));
  // After the intro, a soft check-in every few seconds.
  float idle = uTime - 4.6 - index * 1.7;
  if (idle > 0.0) heat = max(heat, ring(d, mod(idle, 5.6), 150.0, 16.0, 230.0, 0.38));
  return heat;
}

half4 over(half4 dst, float3 color, float alpha) {
  return half4(half3(color * alpha) + dst.rgb * half(1.0 - alpha), half(alpha) + dst.a * half(1.0 - alpha));
}

half4 marker(half4 dst, float4 f, float2 p, float index) {
  if (f.w <= 0.0) return dst;
  float age = uStill > 0.5 ? 1.0 : uTime - f.z;
  if (age < 0.0) return dst;
  float grow = uStill > 0.5 ? 1.0 : easeOut(age / 0.5);
  float breathe = uStill > 0.5 ? 0.0 : sin(uTime * 2.1 + index * 1.3);
  float d = length(p - f.xy);
  float halo = (1.0 - smoothstep(0.75, 1.5, abs(d - (9.0 + 2.0 * breathe) * grow))) * 0.28 * grow;
  dst = over(dst, uSignal, halo);
  dst = over(dst, uGround, (1.0 - smoothstep(5.6 * grow - 0.5, 5.6 * grow + 0.5, d)) * grow);
  dst = over(dst, uSignal, (1.0 - smoothstep(4.2 * grow - 0.5, 4.2 * grow + 0.5, d)) * grow);
  return dst;
}

half4 main(float2 p) {
  float2 cell = floor((p - 2.0) / STEP) * STEP + STEP * 0.5 + 2.0;
  bool still = uStill > 0.5;

  float g = 0.0;
  float a = 0.0;
  if (!still) {
    g = max(max(friendHeat(uF0, cell, 0.0), friendHeat(uF1, cell, 1.0)),
            max(friendHeat(uF2, cell, 2.0), friendHeat(uF3, cell, 3.0)));
    a = ring(length(cell - uYou), uTime - uStarts.x, uYouSpeed, 28.0, uYouReach, 1.0);
  }

  float fieldIn = still ? 1.0 : easeOut(uTime / 0.7);
  float clearT = still ? 1.0 : easeOut((uTime - uStarts.y) / 0.8);
  float2 e2 = (cell - uClear.xy) / uClear.zw;
  float e = dot(e2, e2);
  float mask = e < 0.6 ? 1.0 : (e > 1.0 ? 0.0 : 1.0 - (e - 0.6) / 0.4);

  float hot = clamp(max(g, a), 0.0, 1.0);
  float wave = still ? 0.0 : uTime * 0.9;
  float base = (uBaseA + 0.04 * sin(length(cell - uYou) / 42.0 - wave))
    * fieldIn * (1.0 - 0.85 * mask * clearT) * (1.0 - hot);

  float pixel = length(p - cell);
  float baseMask = 1.0 - smoothstep(0.9, 1.7, pixel);
  float hotRadius = 1.3 + 1.9 * hot;
  float hotMask = 1.0 - smoothstep(hotRadius - 0.5, hotRadius + 0.5, pixel);
  float hotAlpha = min(1.0, hot * 1.1) * (1.0 - 0.6 * mask * clearT) * hotMask;
  float3 hotColor = a > g ? uAmber : uSignal;

  half4 color = half4(0.0);
  color = over(color, uBase, base * baseMask);
  color = over(color, hotColor, hotAlpha);
  color = marker(color, uF0, p, 0.0);
  color = marker(color, uF1, p, 1.0);
  color = marker(color, uF2, p, 2.0);
  color = marker(color, uF3, p, 3.0);
  return color;
}
`;
