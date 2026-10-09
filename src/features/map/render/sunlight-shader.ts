/**
 * A screen-space wash, inverse-projected per pixel so the terminator follows
 * latitude, season and the live camera rather than becoming a vertical stripe.
 * Kept separate from cached region bitmaps: time never invalidates terrain.
 */
export const SUNLIGHT_SKSL = `
uniform float2 uWorldOrigin;
uniform float uWorldPerPixel;
uniform float3 uSun;
uniform float uOpacity;

half4 main(float2 p) {
  if (uOpacity <= 0.0) return half4(0.0);
  float2 world = uWorldOrigin + p * uWorldPerPixel;
  // The polar letterbox and off-world margins are not geography.
  if (world.x < 0.0 || world.x > 1.0 || world.y < 0.0 || world.y > 1.0)
    return half4(0.0);
  float longitude = (world.x - 0.5) * 6.28318530718;
  float n = 3.14159265359 * (1.0 - 2.0 * world.y);
  float e = exp(n);
  float sinLat = (e * e - 1.0) / (e * e + 1.0);
  float cosLat = 2.0 * e / (e * e + 1.0);
  float3 normal = float3(cosLat * cos(longitude), cosLat * sin(longitude), sinLat);
  float altitude = dot(normal, uSun);
  // A broad twilight band (roughly ±9° solar elevation), not a hard night mask.
  float daylight = smoothstep(-0.156434, 0.156434, altitude);
  float3 ink = mix(float3(0.055, 0.085, 0.19), float3(1.0, 0.80, 0.48), daylight);
  float alpha = mix(0.16, 0.075, daylight) * uOpacity;
  return half4(ink * alpha, alpha);
}
`;
