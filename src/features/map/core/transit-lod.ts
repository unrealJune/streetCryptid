import { clamp } from './color';
import { TRANSIT_MODES, type TransitMode } from './types';

/**
 * Transit-line stroke widths and zoom cutoffs — the transit twin of
 * `road-lod.ts`. Transit is drawn as vector paths over the finished region
 * bitmap (`render/transit-paths.ts`), so these are region-**logical** px, not
 * mask px: a transit line is line work, not a coverage stamp, and stays a
 * consistent hairline weight regardless of the mask resolution.
 */

/** Base stroke width per mode, region-logical px. Keyed by {@link TransitMode}. */
export const TRANSIT_WIDTHS: Record<TransitMode, number> = {
  rail: 1.6,
  subway: 2.2,
  light_rail: 2.2,
  tram: 1.4,
  monorail: 1.6,
  funicular: 1.4,
  ferry: 1.2,
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

/** Ferries are a route over water, not track: dashed, so they read as such. */
export const FERRY_DASH: readonly [number, number] = [5, 4];

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
