import { mix, ramp } from './color';
import { roadWidthScale } from './road-lod';
import { TRANSIT_MODES, type MapPalette, type Rgb, type TransitMode } from './types';

/**
 * Transit-line stroke widths and zoom cutoffs — the transit twin of
 * `road-lod.ts`. Transit uses mask-pixel coverage and the same dot-field
 * treatment as highways, including their zoom-dependent width taper.
 */

/** Base stroke width per mode, mask px. Keyed by {@link TransitMode}. */
export const TRANSIT_WIDTHS: Record<TransitMode, number> = {
  rail: 5,
  subway: 5,
  light_rail: 4.5,
  tram: 3.8,
  monorail: 4.5,
  funicular: 3,
  ferry: 4,
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
export const FERRY_DASH: readonly [number, number] = [8, 5];

/** Match the highway taper: full weight at z>=15, 0.4 by z<=11. */
export function transitWidthScale(zoom: number): number {
  return roadWidthScale(zoom);
}

/**
 * Effective stroke width (mask px) for a transit mode at a build
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

/** Theme-relative mode tints, so custom palettes need no new required fields. */
export function transitColorFor(mode: TransitMode, palette: MapPalette): Rgb {
  switch (mode) {
    case 'rail':
      return mix(palette.transit, ramp(palette.terr, 0.9), 0.3);
    case 'ferry':
      return mix(palette.transit, ramp(palette.water, 0.8), 0.45);
    case 'tram':
    case 'funicular':
      return mix(palette.transit, ramp(palette.park, 0.8), 0.25);
    default:
      return palette.transit;
  }
}
