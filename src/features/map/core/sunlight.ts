import { H3_MIN_LADDER_ZOOM } from './cell-ladder';

const RAD = Math.PI / 180;

/**
 * Earth-fixed unit vector toward the sun (x = Greenwich, y = 90°E, z = north).
 * Low-precision solar ephemeris: ecliptic longitude/obliquity → right ascension,
 * then Greenwich sidereal time → terrestrial longitude. UTC, not the phone's zone.
 */
export function sunDirection(timestamp: number): number[] {
  const days = timestamp / 86_400_000 - 10957.5; // J2000: 2000-01-01 12:00 UTC
  const meanLongitude = (280.46 + 0.9856474 * days) * RAD;
  const anomaly = (357.528 + 0.9856003 * days) * RAD;
  const longitude =
    meanLongitude + (1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * RAD;
  const obliquity = (23.439 - 0.0000004 * days) * RAD;
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(longitude), Math.cos(longitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));
  const sidereal = (280.46061837 + 360.98564736629 * days) * RAD;
  const earthLongitude = rightAscension - sidereal;
  return [
    Math.cos(declination) * Math.cos(earthLongitude),
    Math.cos(declination) * Math.sin(earthLongitude),
    Math.sin(declination),
  ];
}

/** Fade over the final world-view zoom level; no wash over the exploration ladder. */
export function sunlightOpacity(zoom: number): number {
  'worklet';
  const t = Math.max(0, Math.min(1, H3_MIN_LADDER_ZOOM - zoom));
  return t * t * (3 - 2 * t);
}
