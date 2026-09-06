import {
  AERO_AREA_STYLE,
  BUILDING_HATCH_MIN_ZOOM,
  buildingHatchVisible,
  AERO_LINE_MIN_ZOOM,
  AERO_LINE_WIDTHS,
  aeroAreaVisible,
  aeroLineWidthFor,
  BUILDING_MIN_ZOOM,
  BUILDING_STROKE_WIDTH,
  buildingStrokeWidthFor,
  structureWidthScale,
} from '../structure-lod';
import { AERO_AREA_KINDS, AERO_LINE_KINDS } from '../types';

describe('structureWidthScale', () => {
  it('is full weight at street zoom and floors at 0.7 when zoomed out', () => {
    expect(structureWidthScale(14)).toBeCloseTo(1, 6);
    expect(structureWidthScale(16)).toBeCloseTo(1, 6);
    expect(structureWidthScale(11)).toBeCloseTo(0.7, 6);
    expect(structureWidthScale(8)).toBeCloseTo(0.7, 6);
  });

  it('tapers monotonically across the band it spans', () => {
    for (let zoom = 11; zoom < 14; zoom += 0.5) {
      expect(structureWidthScale(zoom + 0.5)).toBeGreaterThan(structureWidthScale(zoom));
    }
  });
});

describe('buildingStrokeWidthFor', () => {
  it('drops buildings below the tileset floor, where the layer does not exist', () => {
    expect(buildingStrokeWidthFor(BUILDING_MIN_ZOOM - 0.01)).toBeNull();
    expect(buildingStrokeWidthFor(11)).toBeNull();
  });

  it('draws at full weight from street zoom up', () => {
    expect(buildingStrokeWidthFor(14)).toBeCloseTo(BUILDING_STROKE_WIDTH, 6);
    expect(buildingStrokeWidthFor(16)).toBeCloseTo(BUILDING_STROKE_WIDTH, 6);
  });

  it('tapers at the floor zoom', () => {
    const width = buildingStrokeWidthFor(BUILDING_MIN_ZOOM);
    expect(width).not.toBeNull();
    expect(width!).toBeLessThan(BUILDING_STROKE_WIDTH);
  });
});

describe('aeroLineWidthFor', () => {
  it.each(AERO_LINE_KINDS)('omits %s below its floor zoom', (kind) => {
    expect(aeroLineWidthFor(kind, AERO_LINE_MIN_ZOOM[kind] - 0.01)).toBeNull();
  });

  it.each(AERO_LINE_KINDS)('draws %s at its base width at z14+', (kind) => {
    expect(aeroLineWidthFor(kind, 14)).toBeCloseTo(AERO_LINE_WIDTHS[kind], 6);
  });

  it('keeps runways heavier than taxiways at every zoom they share', () => {
    for (let zoom = 12; zoom <= 16; zoom += 1) {
      expect(aeroLineWidthFor('runway', zoom)!).toBeGreaterThan(aeroLineWidthFor('taxiway', zoom)!);
    }
  });

  it('surfaces runways further out than taxiways — they are the landmark', () => {
    expect(AERO_LINE_MIN_ZOOM.runway).toBeLessThan(AERO_LINE_MIN_ZOOM.taxiway);
  });
});

describe('aeroAreaVisible', () => {
  it.each(AERO_AREA_KINDS)('gates %s on its floor zoom', (kind) => {
    const floor = AERO_AREA_STYLE[kind].minZoom;
    expect(aeroAreaVisible(kind, floor - 0.01)).toBe(false);
    expect(aeroAreaVisible(kind, floor)).toBe(true);
  });

  it('never fills the aerodrome boundary — it spans a whole region', () => {
    expect(AERO_AREA_STYLE.aerodrome.fillAlpha).toBe(0);
    expect(AERO_AREA_STYLE.apron.fillAlpha).toBeGreaterThan(0);
  });
});

describe('buildingHatchVisible', () => {
  it('gates the hatch on its own zoom, above the buildings floor', () => {
    expect(buildingHatchVisible(BUILDING_HATCH_MIN_ZOOM)).toBe(true);
    expect(buildingHatchVisible(BUILDING_HATCH_MIN_ZOOM - 0.01)).toBe(false);
  });

  it('leaves a band where buildings draw plain — too small to hatch legibly', () => {
    expect(BUILDING_HATCH_MIN_ZOOM).toBeGreaterThan(BUILDING_MIN_ZOOM);
    expect(buildingStrokeWidthFor(BUILDING_MIN_ZOOM)).not.toBeNull();
    expect(buildingHatchVisible(BUILDING_MIN_ZOOM)).toBe(false);
  });
});
