import { clamp } from './color';

/**
 * Base stroke widths per road class 0–4, logical px. Deliberately thinner than
 * a road's real footprint: the dot field samples this mask, so a stroke wide
 * enough to swallow the gap between two parallel residential streets turns the
 * whole block into a lit surface (the "grey-out").
 */
export const ROAD_WIDTHS = [1.5, 2.0, 2.9, 3.8, 5.0] as const;

/**
 * Mask brightness per road class 0-4 - what the dot field reads a street's
 * importance off, sampled through the terrain ramp.
 *
 * These are spread across the ramp on purpose. The previous ladder
 * (128/170/205/225/245) occupied 0.50-0.96 of it: nothing on the map was
 * allowed to be quieter than a service alley, the bottom half of the ramp went
 * unused, and the three classes that carry the actual hierarchy sat within 0.16
 * of each other. On a real downtown frame that put 40-51% of the dot field's
 * dots on road - class 0 alone is ~78% of the street features at z16 and paints
 * about a fifth of the frame - and left the city under it with nowhere to go.
 *
 * The band the background/building noise occupies is 0.24-0.37 of the ramp
 * (`dot-field-sksl.ts`), and the ladder is placed around it: class 0 lands just
 * under that band so driveways and footpaths recede into the ground, class 1
 * just over it so the residential grid still reads as a network, and 2-4 take
 * the top with real gaps between them.
 *
 * Note the second, free effect: the shader derives dot RADIUS from the same
 * value, so a quieter class is also a smaller dot. Width (ROAD_WIDTHS) was
 * already encoding class; this stops brightness from shouting the same thing.
 */
export const ROAD_VALUES = [56, 104, 162, 206, 246] as const;

/**
 * The mask value at which a road may claim a dot whose centre it does not
 * actually cover.
 *
 * `dot-field-sksl.ts` samples the street channel at four offsets around each
 * dot as well as at its centre, so a stroke thinner than the lattice step
 * cannot fall between dots and come out dashed. That is the right fix for one
 * 1.5 px arterial and the wrong one for the six hundred service roads in a
 * downtown tile, where it is what turns a street network into a solid field.
 *
 * Sitting between class 0 and class 1, it lets everything from residential up
 * keep the old behaviour and lets service/track/path fall through the lattice -
 * which is what a field of finite dots should do with a feature narrower than
 * its own step.
 */
export const ROAD_DILATE_MIN = 96;

/**
 * The mask value below which the dot field stops calling a sample a street.
 *
 * It is an antialiasing cutoff, not a feature gate: a stroke's edge pixel holds
 * coverage times the class value, so without a floor every road would carry a
 * fringe of near-invisible dots a pixel out from its actual edge.
 *
 * It is therefore COUPLED to the bottom of the ladder, and the relationship it
 * wants is exactly half of it: at `ROAD_VALUES[0] / 2` the cutoff falls on the
 * 50%-coverage point of the quietest class, so a class-0 stroke renders at its
 * nominal width - no fringe, no erosion. Lower ROAD_VALUES[0] without lowering
 * this and service roads start eating inward from their own edges.
 * `road-lod.test.ts` pins it.
 */
export const ROAD_MASK_FLOOR = 28;

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
