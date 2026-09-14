import { formatDistanceValue } from '../distance-units';

describe('distance units', () => {
  it('keeps metric as the default, with the existing precision', () => {
    expect(formatDistanceValue(114)).toBe('110 m');
    expect(formatDistanceValue(2400)).toBe('2.4 km');
    expect(formatDistanceValue(12_450)).toBe('12 km');
  });

  it('converts short distances to feet and longer distances to miles', () => {
    expect(formatDistanceValue(114, 'mi')).toBe('370 ft');
    expect(formatDistanceValue(1609.344, 'mi')).toBe('1.0 mi');
    expect(formatDistanceValue(2400, 'mi')).toBe('1.5 mi');
    expect(formatDistanceValue(32_186.88, 'mi')).toBe('20 mi');
  });

  it('does not manufacture distances from missing or invalid values', () => {
    for (const value of [null, NaN, Infinity]) {
      expect(formatDistanceValue(value, 'km')).toBeNull();
      expect(formatDistanceValue(value, 'mi')).toBeNull();
    }
    expect(formatDistanceValue(-10)).toBe('0 m');
    expect(formatDistanceValue(-10, 'mi')).toBe('0 ft');
  });
});
