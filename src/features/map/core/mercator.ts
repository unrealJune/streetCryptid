import type { LatLon, WorldPoint } from './types';

/** Web Mercator's latitude cutoff (±85.05113°), where world y reaches 0/1. */
export const MAX_LATITUDE = 85.05112877980659;

/**
 * Project geographic coordinates into normalized Web Mercator world space:
 * the planet spans [0,1]², x grows east from the antimeridian, y grows south
 * from the north cutoff. Standard XYZ-tile orientation.
 */
export function latLonToWorld({ lat, lon }: LatLon): WorldPoint {
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const x = lon / 360 + 0.5;
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return [x, y];
}

/** Inverse of {@link latLonToWorld}. */
export function worldToLatLon([x, y]: WorldPoint): LatLon {
  const lon = (x - 0.5) * 360;
  const n = Math.PI * (1 - 2 * y);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

/**
 * Ground meters per world unit at a given latitude (mercator stretches with
 * 1/cos φ). Useful for sizing hex sectors in real-world terms.
 */
export function metersPerWorldUnit(lat: number): number {
  const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
  return EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180);
}
