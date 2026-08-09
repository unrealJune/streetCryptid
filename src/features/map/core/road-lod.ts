import { clamp } from './color';

/**
 * Base stroke widths per road class 0–4, logical px. Deliberately thinner than
 * a road's real footprint: the dot field samples this mask, so a stroke wide
 * enough to swallow the gap between two parallel residential streets turns the
 * whole block into a lit surface (the "grey-out").
 */
export const ROAD_WIDTHS = [1.5, 2.0, 2.9, 3.8, 5.0] as const;

/**
 * Below this build zoom, a road class is omitted entirely (declutters city /
 * region / global views). Index = road class 0..4: service/path off below
 * z15, residential below z13.5, secondary/tertiary below z11, primary below
 * z8.5, motorways always draw (they're the only roads that read at globe
 * zooms). Each class leaves before its grid spacing shrinks below its own
 * stroke width, so the classes below never merge into a solid field.
 */
export const CLASS_MIN_ZOOM = [15.0, 13.5, 11.0, 8.5, 0] as const;

/**
 * Road class of motorways — the widest, brightest strokes in the mask. They
 * read as thick bars across a city view, so the map layers control lets them be
 * switched off; see {@link RoadLayerOptions}. Trunk roads are deliberately NOT
 * in this class (see `tiles/mvt-mapping.ts`): OMT tags ordinary divided city
 * arterials `trunk`, so they ride with primary.
 */
export const HIGHWAY_CLASS = 4;

/** Per-render road layer switches (user-facing map layer toggles). */
export interface RoadLayerOptions {
  /** When false, motorways are omitted from the mask entirely. */
  readonly highways?: boolean;
}

/** True when a road class should be drawn at all, given the layer toggles. */
export function roadClassVisible(roadClass: number, options?: RoadLayerOptions): boolean {
  return options?.highways === false ? roadClass !== HIGHWAY_CLASS : true;
}

/**
 * Global stroke-width multiplier: full detail at z>=15, tapering to 0.4 by
 * z<=11. Zooming out thins every stroke rather than letting a fixed width eat
 * the shrinking space between roads.
 */
export function roadWidthScale(zoom: number): number {
  return clamp(0.4 + (0.6 * (zoom - 11)) / 4, 0.4, 1);
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
