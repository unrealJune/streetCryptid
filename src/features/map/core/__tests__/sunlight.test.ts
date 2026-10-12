import { H3_MIN_LADDER_ZOOM } from '../cell-ladder';
import { sunDirection, sunlightOpacity } from '../sunlight';

const sunAt = (date: string) => sunDirection(Date.parse(date));
const declination = (sun: number[]) => (Math.asin(sun[2]) * 180) / Math.PI;
const longitude = (sun: number[]) => (Math.atan2(sun[1], sun[0]) * 180) / Math.PI;

describe('solar direction', () => {
  it('puts the equinox noon sun near the equator and Greenwich', () => {
    const sun = sunAt('2026-03-20T12:00:00Z');
    expect(Math.abs(declination(sun))).toBeLessThan(0.3);
    // Equation of time means civil noon is not exactly solar noon.
    expect(Math.abs(longitude(sun))).toBeLessThan(2);
    expect(sun[0]).toBeGreaterThan(0.99);
  });

  it('moves west with UTC and lights the opposite side at midnight', () => {
    const morning = sunAt('2026-03-20T06:00:00Z');
    const evening = sunAt('2026-03-20T18:00:00Z');
    expect(longitude(morning)).toBeCloseTo(92, 0);
    expect(longitude(evening)).toBeCloseTo(-88, 0);
    expect(sunAt('2026-03-20T00:00:00Z')[0]).toBeLessThan(-0.99);
  });

  it('tilts the terminator for summer/winter and polar day/night', () => {
    const summer = sunAt('2026-06-21T12:00:00Z');
    const winter = sunAt('2026-12-21T12:00:00Z');
    expect(declination(summer)).toBeCloseTo(23.44, 1);
    expect(declination(winter)).toBeCloseTo(-23.44, 1);
    expect(summer[2]).toBeGreaterThan(0);
    expect(winter[2]).toBeLessThan(0);
  });

  it.each(['2000-01-01T12:00:00Z', '2028-02-29T23:59:59Z', '2030-10-07T00:00:00Z'])(
    'returns a unit vector at %s',
    (date) => {
      expect(Math.hypot(...sunAt(date))).toBeCloseTo(1, 12);
    }
  );

  it('depends on the instant, not its time-zone representation', () => {
    expect(sunAt('2026-10-07T12:00:00+09:00')).toEqual(sunAt('2026-10-07T03:00:00Z'));
  });
});

describe('sunlight zoom fade', () => {
  it('is fully present at far zoom and gone before exploration appears', () => {
    expect(sunlightOpacity(1)).toBe(1);
    expect(sunlightOpacity(H3_MIN_LADDER_ZOOM - 1)).toBe(1);
    expect(sunlightOpacity(H3_MIN_LADDER_ZOOM - 0.5)).toBeCloseTo(0.5);
    expect(sunlightOpacity(H3_MIN_LADDER_ZOOM)).toBe(0);
    expect(sunlightOpacity(15)).toBe(0);
  });
});
