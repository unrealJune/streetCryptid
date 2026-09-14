import { clamp } from './color';
import { TRANSIT_MODES, type TransitMode } from './types';

/**
 * Transit-line stroke widths and zoom cutoffs — the transit twin of
 * `road-lod.ts`. Transit is drawn as dotted paths over the finished region
 * bitmap (`render/transit-paths.ts`), so these are region-**logical** px, not
 * mask px. The stroke width becomes the dot diameter (`core/dot-style.ts`),
 * independent of mask resolution.
 *
 * These are deliberately in MOTORWAY territory rather than hairline territory.
 * A transit line is the one thing on this map you cannot deduce from the
 * ground: a street grid is legible from the dot field alone, but where the
 * trains run is invisible unless it is drawn loud. At the old rail-1.6 /
 * subway-2.2 weights the layer was thinner than the motorways it parallels and
 * disappeared into the field at exactly the city zooms it exists for — compare
 * `ROAD_WIDTHS`, whose motorway is 5 mask px.
 */

/** Base stroke width per mode, region-logical px. Keyed by {@link TransitMode}. */
export const TRANSIT_WIDTHS: Record<TransitMode, number> = {
  rail: 3.4,
  subway: 4.2,
  light_rail: 4,
  tram: 2.8,
  monorail: 3.2,
  funicular: 2.6,
  ferry: 2.6,
};

/**
 * Below this camera zoom a mode is omitted entirely. Heavy rail and ferries
 * are inter-city scale so they survive furthest out; trams and funiculars are
 * street furniture and only appear once streets do.
 */
export const TRANSIT_MIN_ZOOM: Record<TransitMode, number> = {
  rail: 8,
  subway: 9,
  light_rail: 9,
  tram: 12,
  monorail: 11,
  funicular: 13,
  ferry: 7,
};

/**
 * Transit-line opacity per mode. Rapid transit (subway/light rail/monorail) is
 * the spine people navigate by, so it reads strongest; heavy rail, trams and
 * ferries sit one step back. The whole table is louder than it was: this layer
 * SHOULD compete with the dot field, because the field cannot say where a train
 * goes and nothing else on the map can either.
 *
 * Here rather than beside the draw call because `scripts/map-shot.ts` renders
 * the same layer through CanvasKit and cannot import the Skia render module. It
 * kept a hand-copied duplicate of this table, which is exactly how a shot stops
 * being evidence about the app.
 */
export const TRANSIT_ALPHA: Record<TransitMode, number> = {
  rail: 0.82,
  subway: 1,
  light_rail: 1,
  tram: 0.8,
  monorail: 0.92,
  funicular: 0.76,
  ferry: 0.68,
};

/**
 * The continuous stroke under each mode's dots, as a fraction of its alpha.
 *
 * Dots alone are texture, not a route: at a glance a chain of them reads as a
 * row of unrelated marks, which is exactly why the layer vanished. The casing
 * is what makes it a LINE — it carries the connection at arm's length while the
 * dots keep the transit idiom close up, the same trick a printed transit map
 * plays with a tinted band under a dashed overlay.
 */
export const TRANSIT_CASING_ALPHA = 0.42;

/** Global stroke-width multiplier: full weight at z>=14, tapering to 0.7 by z<=11. */
export function transitWidthScale(zoom: number): number {
  return clamp(0.7 + (0.3 * (zoom - 11)) / 3, 0.7, 1);
}

/**
 * Effective stroke width (region-logical px) for a transit mode at a build
 * zoom, or null when the mode should be omitted at this zoom.
 */
export function transitWidthFor(mode: TransitMode, zoom: number): number | null {
  if (zoom < TRANSIT_MIN_ZOOM[mode]) return null;
  return TRANSIT_WIDTHS[mode] * transitWidthScale(zoom);
}

/** The modes that draw at `zoom`, in {@link TRANSIT_MODES} order. */
export function activeTransitModes(zoom: number): readonly TransitMode[] {
  return TRANSIT_MODES.filter((mode) => transitWidthFor(mode, zoom) !== null);
}
