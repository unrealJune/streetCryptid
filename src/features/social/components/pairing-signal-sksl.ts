/**
 * The pairing signal field: a dot lattice that reports what the radio is doing.
 *
 * Every state of the pairing route drives the same lattice through a different motion,
 * so the field reads as one continuous instrument rather than six separate loaders. Mode
 * changes are therefore crossfaded rather than cut: the shader evaluates the outgoing and
 * incoming motions together and mixes them, which is what `uModeFrom`/`uModeTo`/`uModeMix`
 * are for. Holding both is cheap — the lattice is a few hundred live dots — and it is the
 * difference between the field morphing and the field blinking.
 */
export const PAIRING_SIGNAL_SKSL = `
uniform float2 uSize;
uniform float uTime;
uniform float uModeFrom;
uniform float uModeTo;
uniform float uModeMix;
uniform float uProgress;
uniform float3 uAccent;
uniform float3 uBase;

const float DESIGN_SIZE = 708.0;
const float STEP = 20.0;
const float FIELD_RADIUS = 330.0;
const float PI = 3.141592653589793;
const float TWO_PI = 6.283185307179586;

float normalizedAngle(float angle) {
  float value = mod(angle, TWO_PI);
  return value < 0.0 ? value + TWO_PI : value;
}

/**
 * One mode's contribution to a single dot.
 * x = how "hot" (accent-lit) the dot is, y = extra resting brightness the mode adds.
 */
float2 fieldFor(float mode, float2 grid, float2 delta, float distanceFromCenter) {
  if (mode < 0.5) {
    // pulse — a ring leaving the centre, over and over: the phone is listening.
    float radius = mod(uTime * 120.0, 340.0);
    float hot = max(0.0, 1.0 - abs(distanceFromCenter - radius) / 26.0)
      * (1.0 - distanceFromCenter / 360.0);
    return float2(hot, 0.0);
  }
  if (mode < 1.5) {
    // sweep — a radar arm: candidate phones are being ranked.
    float angle = normalizedAngle(atan(delta.y, delta.x) - uTime * 1.7);
    float hot = max(0.0, 1.0 - angle / 1.1) * (distanceFromCenter < 300.0 ? 1.0 : 0.0);
    return float2(hot, 0.0);
  }
  if (mode < 2.5) {
    // countdown — a ring that drains clockwise from twelve o'clock as the link expires.
    float ring = max(0.0, 1.0 - abs(distanceFromCenter - 252.0) / 16.0);
    float angle = normalizedAngle(atan(delta.y, delta.x) + PI * 0.5);
    return float2(ring * (angle / TWO_PI < uProgress ? 1.0 : 0.12), ring * 0.08);
  }
  if (mode < 3.5) {
    // inward — rings falling towards the centre: reaching for the phone that made the link.
    float radius = 320.0 - mod(uTime * 110.0, 340.0);
    float hot = max(0.0, 1.0 - abs(distanceFromCenter - radius) / 24.0)
      * (1.0 - distanceFromCenter / 420.0);
    return float2(hot, 0.0);
  }
  if (mode < 4.5) {
    // converge — two vertical bands closing on the middle: two phones meeting.
    float gap = 150.0 * (0.5 + 0.5 * cos(uTime * 1.6));
    float hot = max(0.0, 1.0 - abs(abs(delta.x) - gap) / 22.0)
      * max(0.0, 1.0 - abs(delta.y) / 220.0);
    return float2(hot, 0.0);
  }
  if (mode < 5.5) {
    // scatter — uncorrelated sparks: contact was never made.
    float noise = sin(grid.x * 0.07 + grid.y * 0.11 + uTime * 0.9);
    return float2(noise > 0.86 ? (noise - 0.86) * 5.0 : 0.0, 0.0);
  }
  // fracture — a shock front leaving the centre, then silence: contact was made, and it broke.
  //
  // Deliberately not scatter. Scatter is a field that never found anything and keeps trying;
  // fracture is a field that HAD something. So it starts from a single break at the centre, throws
  // one hard ring outward, and then goes quiet for most of the cycle — the lattice left standing
  // but dark. The long pause is the point: it is what makes this read as an ending.
  float cycle = mod(uTime, 2.6);
  float front = cycle * 340.0;
  float shock = max(0.0, 1.0 - abs(distanceFromCenter - front) / 30.0)
    * max(0.0, 1.0 - cycle / 1.0);
  // Debris: dots near the front jitter off their lattice position as the wave passes them.
  float passed = clamp((front - distanceFromCenter) / 60.0, 0.0, 1.0);
  float jitter = sin(grid.x * 0.13 + grid.y * 0.09) * passed * max(0.0, 1.0 - cycle / 1.6);
  return float2(shock + max(0.0, jitter) * 0.5, -0.03 * passed);
}

half4 main(float2 position) {
  float scale = DESIGN_SIZE / max(1.0, uSize.x);
  float2 point = position * scale;
  float2 grid = floor(point / STEP + 0.5) * STEP;
  float2 delta = grid - float2(DESIGN_SIZE * 0.5);
  float distanceFromCenter = length(delta);

  if (
    grid.x < STEP || grid.x >= DESIGN_SIZE ||
    grid.y < STEP || grid.y >= DESIGN_SIZE ||
    distanceFromCenter > FIELD_RADIUS
  ) {
    return half4(0.0);
  }

  float2 field = uModeMix >= 1.0
    ? fieldFor(uModeTo, grid, delta, distanceFromCenter)
    : mix(
        fieldFor(uModeFrom, grid, delta, distanceFromCenter),
        fieldFor(uModeTo, grid, delta, distanceFromCenter),
        uModeMix
      );

  float base = 0.07 + 0.025 * (sin(distanceFromCenter / 38.0 - uTime * 0.8) + 1.0) + field.y;
  float hot = clamp(field.x, 0.0, 1.0);

  float pixelDistance = length(point - grid);
  float baseMask = 1.0 - smoothstep(2.1, 3.1, pixelDistance);
  float hotRadius = 2.6 + hot * 1.6;
  float hotMask = 1.0 - smoothstep(hotRadius - 0.5, hotRadius + 0.5, pixelDistance);
  float baseAlpha = base * (1.0 - hot) * baseMask;
  float hotAlpha = hot * hotMask;
  float alpha = hotAlpha + baseAlpha * (1.0 - hotAlpha);

  if (alpha <= 0.001) {
    return half4(0.0);
  }

  // Runtime effects return PREMULTIPLIED colour. Dividing through by alpha here would scale a
  // 12%-opacity resting dot back up to full brightness and clip it to white, which turns the
  // lattice from a texture into a hard grid of bright pixels.
  float3 premultiplied = uAccent * hotAlpha + uBase * baseAlpha * (1.0 - hotAlpha);
  return half4(premultiplied, alpha);
}
`;
