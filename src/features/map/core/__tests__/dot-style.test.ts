import { DOT_STEP, lineDotIntervals } from '../dot-style';
import { aeroLineWidthFor } from '../structure-lod';
import { transitWidthFor } from '../transit-lod';
import { TRANSIT_MODES } from '../types';

describe('lineDotIntervals', () => {
  it('uses zero-length marks so round caps produce circles, not capsules', () => {
    expect(lineDotIntervals(2)).toEqual([0, DOT_STEP * 2]);
  });

  it.each(TRANSIT_MODES)('keeps separated %s dots throughout its zoom LOD', (mode) => {
    for (let zoom = 7; zoom <= 18; zoom += 0.25) {
      const width = transitWidthFor(mode, zoom);
      if (width === null) continue;
      const [mark, interval] = lineDotIntervals(width);
      expect(mark).toBe(0);
      expect(interval).toBeGreaterThanOrEqual(DOT_STEP * 2);
      expect(interval - width).toBeGreaterThanOrEqual(width);
    }
  });

  it('preserves a diameter of clear space between the heavier runway dots', () => {
    for (let zoom = 10; zoom <= 18; zoom += 0.25) {
      const width = aeroLineWidthFor('runway', zoom)!;
      expect(lineDotIntervals(width)).toEqual([0, width * 2]);
    }
  });
});
