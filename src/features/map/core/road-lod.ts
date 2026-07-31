import { clamp } from './color';

/** Base stroke widths per road class 0–4, logical px — the mock's RW. */
export const ROAD_WIDTHS = [2.2, 3.0, 4.2, 5.4, 7.0] as const;

/**
 * Below this build zoom, a road class is omitted entirely (declutters city /
 * region / global views). Index = road class 0..4: service/path off below
 * z13.5, residential below z12, secondary/tertiary below z9, primary below z7,
 * motorways always draw (they're the only roads that read at globe zooms).
 */
export const CLASS_MIN_ZOOM = [13.5, 12.0, 9.0, 7.0, 0] as const;

/**
 * Road class of motorways / trunk roads — the widest, brightest strokes in the
 * mask. They read as thick bars across a city view, so the map layers control
 * lets them be switched off; see {@link RoadLayerOptions}.
 */
export const HIGHWAY_CLASS = 4;

/** Per-render road layer switches (user-facing map layer toggles). */
export interface RoadLayerOptions {
  /** When false, motorway/trunk roads are omitted from the mask entirely. */
  readonly highways?: boolean;
}

/** True when a road class should be drawn at all, given the layer toggles. */
export function roadClassVisible(roadClass: number, options?: RoadLayerOptions): boolean {
  return options?.highways === false ? roadClass !== HIGHWAY_CLASS : true;
}

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
