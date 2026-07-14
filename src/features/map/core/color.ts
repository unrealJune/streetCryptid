import type { RampStop, Rgb } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Piecewise-linear color ramp lookup; `t` is clamped to [0,1]. */
export function ramp(stops: readonly RampStop[], t: number): Rgb {
  const tc = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const b = stops[i + 1];
    if (tc <= b.t) {
      const a = stops[i];
      const k = (tc - a.t) / (b.t - a.t || 1);
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k,
      ];
    }
  }
  return stops[stops.length - 1].rgb;
}

export function mix(c: Rgb, d: Rgb, t: number): Rgb {
  return [c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t, c[2] + (d[2] - c[2]) * t];
}

/** Rec. 601 luma, the mock's grayscale reference for fog desaturation. */
export function luminance(c: Rgb): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

export function rgbToHex(color: Rgb): string {
  return `#${color
    .map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Fog-of-war color transform: explored (fog=0) keeps the true color; unexplored
 * drains 74% toward its own gray, then 24% toward the background. Area features
 * (water/park) cap fog at 0.5 so basins always read.
 */
export function applyFog(color: Rgb, bg: Rgb, fog: number, isArea: boolean): Rgb {
  const fg = isArea ? Math.min(fog, 0.5) : fog;
  const lum = luminance(color);
  return mix(mix(color, [lum, lum, lum], fg * 0.74), bg, fg * 0.24);
}

/** Pack a color + alpha (0–1) into 0xRRGGBBAA (unsigned 32-bit). */
export function packRgba(c: Rgb, alpha: number): number {
  const r = clamp(Math.round(c[0]), 0, 255);
  const g = clamp(Math.round(c[1]), 0, 255);
  const b = clamp(Math.round(c[2]), 0, 255);
  const a = clamp(Math.round(alpha * 255), 0, 255);
  // >>> 0 keeps the result an unsigned 32-bit value (r << 24 can overflow to negative).
  return ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/** Unpack 0xRRGGBBAA into [r, g, b, a01] with alpha back in 0–1. */
export function unpackRgba(packed: number): readonly [number, number, number, number] {
  return [
    (packed >>> 24) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 8) & 0xff,
    (packed & 0xff) / 255,
  ];
}
