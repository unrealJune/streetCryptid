import {
  activeTransitModes,
  TRANSIT_MIN_ZOOM,
  TRANSIT_WIDTHS,
  transitWidthFor,
  transitWidthScale,
} from '../transit-lod';
import { TRANSIT_MODES } from '../types';

describe('transitWidthScale', () => {
  it('is 1.0 at full detail (z >= 14)', () => {
    expect(transitWidthScale(14)).toBeCloseTo(1, 12);
    expect(transitWidthScale(16)).toBeCloseTo(1, 12);
  });

  it('floors at 0.7 when zoomed out (z <= 11)', () => {
    expect(transitWidthScale(11)).toBeCloseTo(0.7, 12);
    expect(transitWidthScale(6)).toBeCloseTo(0.7, 12);
  });

  it('increases monotonically across the taper band', () => {
    let prev = transitWidthScale(11);
    for (let z = 11.25; z <= 14; z += 0.25) {
      const cur = transitWidthScale(z);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('transitWidthFor', () => {
  it.each(TRANSIT_MODES)('omits %s below its min zoom and draws it above', (mode) => {
    expect(transitWidthFor(mode, TRANSIT_MIN_ZOOM[mode] - 0.01)).toBeNull();
    expect(transitWidthFor(mode, TRANSIT_MIN_ZOOM[mode])).toBeGreaterThan(0);
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
