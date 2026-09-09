import { locateCamera } from '../locate-camera';
import { computeRegionSpec } from '../region';
import { latLonToWorld } from '../mercator';

const viewport = { width: 390, height: 844 };
const seattle = latLonToWorld({ lat: 47.6, lon: -122.3 });
const newYork = latLonToWorld({ lat: 40.7, lon: -74 });
const current = { center: seattle, zoom: 18 };
const region = computeRegionSpec(current, viewport, { dataZooms: { min: 0, max: 14 } });

it('caps an uncovered cross-country locate below the full-detail fetch threshold', () => {
  expect(locateCamera(current, newYork, viewport, region, 1, 18)).toEqual({
    center: newYork,
    zoom: 15,
  });
});

it('preserves close zoom for a covered destination', () => {
  expect(locateCamera(current, seattle, viewport, region, 1, 18)).toEqual(current);
});

it('keeps the locate floor and dataset bounds', () => {
  expect(locateCamera({ ...current, zoom: 3 }, newYork, viewport, null, 1, 18).zoom).toBe(13);
  expect(locateCamera(current, newYork, viewport, null, 16, 18).zoom).toBe(16);
  expect(locateCamera(current, newYork, viewport, null, 1, 12).zoom).toBe(12);
});
