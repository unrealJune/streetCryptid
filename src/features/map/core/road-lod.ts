import { clamp } from './color';

/** Base stroke widths per road class 0–4, logical px — the mock's RW. */
export const ROAD_WIDTHS = [2.2, 3.0, 4.2, 5.4, 7.0] as const;

/**
 * Below this build zoom, a road class is omitted entirely (declutters city /
 * region views). Index = road class 0..4. Classes 2–4 (arterials) always draw.
 */
export const CLASS_MIN_ZOOM = [13.5, 12.0, 0, 0, 0] as const;

/** Global stroke-width multiplier: full detail at z>=14, tapering to 0.6 by z<=11. */
export function roadWidthScale(zoom: number): number {
  return clamp(0.6 + (0.4 * (zoom - 11)) / 3, 0.6, 1);
}

/**
 * Effective mask-px stroke width for a road class at a build zoom, or null when
 * the class should be omitted at this zoom. Multiplies the base ROAD_WIDTHS[class]
 * by roadWidthScale(zoom). Returns null iff zoom < CLASS_MIN_ZOOM[class].
 */
export function roadWidthFor(roadClass: number, zoom: number): number | null {
  if (zoom < CLASS_MIN_ZOOM[roadClass]) return null;
  return ROAD_WIDTHS[roadClass] * roadWidthScale(zoom);
}
