import {
  activeTransitModes,
  transitColorFor,
  TRANSIT_MIN_ZOOM,
  TRANSIT_WIDTHS,
  transitWidthFor,
  transitWidthScale,
} from '../transit-lod';
import { TRANSIT_MODES } from '../types';
import { HIGHWAY_CLASS, roadWidthFor } from '../road-lod';
import { BUILT_IN_MAP_COLOR_SCHEMES } from '../../theme/map-color-schemes';

describe('transitWidthScale', () => {
  it('is 1.0 at full detail (z >= 15)', () => {
    expect(transitWidthScale(15)).toBeCloseTo(1, 12);
    expect(transitWidthScale(16)).toBeCloseTo(1, 12);
  });

  it('floors at 0.4 when zoomed out (z <= 11)', () => {
    expect(transitWidthScale(11)).toBeCloseTo(0.4, 12);
    expect(transitWidthScale(6)).toBeCloseTo(0.4, 12);
  });

  it('increases monotonically across the taper band', () => {
    let prev = transitWidthScale(11);
    for (let z = 11.25; z <= 15; z += 0.25) {
      const cur = transitWidthScale(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('transitWidthFor', () => {
  it.each([9, 11, 13, 15, 17])('gives rail and subway highway weight at z%s', (zoom) => {
    expect(transitWidthFor('rail', zoom)).toBe(roadWidthFor(HIGHWAY_CLASS, zoom));
    expect(transitWidthFor('subway', zoom)).toBe(roadWidthFor(HIGHWAY_CLASS, zoom));
  });
  it.each(TRANSIT_MODES)('omits %s below its min zoom and draws it above', (mode) => {
    expect(transitWidthFor(mode, TRANSIT_MIN_ZOOM[mode] - 0.01)).toBeNull();
    expect(transitWidthFor(mode, TRANSIT_MIN_ZOOM[mode])).toBeGreaterThan(0);
  });

  describe('transitColorFor', () => {
    it.each(BUILT_IN_MAP_COLOR_SCHEMES)('keeps mode colors theme-relative in $id', (scheme) => {
      for (const palette of [scheme.light, scheme.dark]) {
        expect(transitColorFor('subway', palette)).toEqual(palette.transit);
        expect(transitColorFor('rail', palette)).not.toEqual(transitColorFor('subway', palette));
        expect(transitColorFor('ferry', palette)).not.toEqual(transitColorFor('rail', palette));
        expect(transitColorFor('ferry', palette)).not.toEqual(transitColorFor('subway', palette));
        for (const mode of TRANSIT_MODES) {
          for (const channel of transitColorFor(mode, palette)) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(255);
          }
        }
      }
    });
  });

  it('equals TRANSIT_WIDTHS[mode] * transitWidthScale(zoom) when not omitted', () => {
    expect(transitWidthFor('subway', 12.5)).toBeCloseTo(
      TRANSIT_WIDTHS.subway * transitWidthScale(12.5),
      12
    );
    expect(transitWidthFor('ferry', 15)).toBeCloseTo(TRANSIT_WIDTHS.ferry * 1, 12);
  });

  it('drops every mode at globe zoom', () => {
    expect(activeTransitModes(4)).toEqual([]);
  });
});

describe('activeTransitModes', () => {
  it('adds modes as the camera zooms in, never removing one', () => {
    let prev = 0;
    for (let z = 4; z <= 16; z += 0.5) {
      const active = activeTransitModes(z);
      expect(active.length).toBeGreaterThanOrEqual(prev);
      prev = active.length;
    }
    expect(activeTransitModes(16)).toEqual([...TRANSIT_MODES]);
  });

  it('keeps regional rail and ferries at city zoom, street rail only close in', () => {
    expect(activeTransitModes(9)).toEqual(['rail', 'subway', 'light_rail', 'ferry']);
    expect(activeTransitModes(13)).toContain('tram');
  });
});
