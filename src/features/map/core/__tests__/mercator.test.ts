import { MAX_LATITUDE, latLonToWorld, metersPerWorldUnit, worldToLatLon } from '../mercator';

describe('latLonToWorld', () => {
  it('maps the null island to the world center', () => {
    const [x, y] = latLonToWorld({ lat: 0, lon: 0 });
    expect(x).toBeCloseTo(0.5, 12);
    expect(y).toBeCloseTo(0.5, 12);
  });

  it('maps the mercator latitude cutoffs to the top/bottom edges', () => {
    expect(latLonToWorld({ lat: MAX_LATITUDE, lon: 0 })[1]).toBeCloseTo(0, 9);
    expect(latLonToWorld({ lat: -MAX_LATITUDE, lon: 0 })[1]).toBeCloseTo(1, 9);
    // beyond the cutoff clamps instead of diverging
    expect(latLonToWorld({ lat: 90, lon: 0 })[1]).toBeCloseTo(0, 9);
  });

  it('x grows east, y grows south', () => {
    const west = latLonToWorld({ lat: 47, lon: -122 });
    const east = latLonToWorld({ lat: 47, lon: -121 });
    const north = latLonToWorld({ lat: 48, lon: -122 });
    expect(east[0]).toBeGreaterThan(west[0]);
    expect(north[1]).toBeLessThan(west[1]);
  });

  it('round-trips with worldToLatLon', () => {
    const seattle = { lat: 47.6062, lon: -122.3321 };
    const { lat, lon } = worldToLatLon(latLonToWorld(seattle));
    expect(lat).toBeCloseTo(seattle.lat, 9);
    expect(lon).toBeCloseTo(seattle.lon, 9);
  });
});

describe('metersPerWorldUnit', () => {
  it('equals the equatorial circumference at the equator', () => {
    expect(metersPerWorldUnit(0)).toBeCloseTo(40_075_016.686, 3);
  });

  it('shrinks toward the poles', () => {
    expect(metersPerWorldUnit(47.6)).toBeLessThan(metersPerWorldUnit(0));
    expect(metersPerWorldUnit(47.6)).toBeCloseTo(
      40_075_016.686 * Math.cos((47.6 * Math.PI) / 180),
      3
    );
  });
});
