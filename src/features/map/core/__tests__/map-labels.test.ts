import { scaleFor } from '../camera';
import { AREA_LABEL_MIN_ZOOM, labelWidthPx, LABEL_MIN_ZOOM, selectMapLabels } from '../map-labels';
import type { RegionSpec } from '../region';
import type { AreaFeature, MapGeometry, RoadClass, StreetWay, WorldPoint } from '../types';
import { packGeometry } from '../../tiles/packed-geometry';

function specAt(zoom: number): RegionSpec {
  return {
    rect: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    maskWidth: 512,
    maskHeight: 512,
    zoom,
    tileZoom: 13,
    cellRes: 9,
  };
}

/** A straight street of `lengthPx` on-screen length at `zoom`, heading `dir`. */
function street(options: {
  name?: string;
  roadClass: RoadClass;
  lengthPx: number;
  zoom: number;
  start?: WorldPoint;
  dir?: readonly [number, number];
}): StreetWay {
  const { name, roadClass, lengthPx, zoom, start = [0.5, 0.5], dir = [1, 0] } = options;
  const norm = Math.hypot(dir[0], dir[1]);
  const span = lengthPx / scaleFor(zoom);
  return {
    roadClass,
    name,
    points: [start, [start[0] + (dir[0] / norm) * span, start[1] + (dir[1] / norm) * span]],
  };
}

/** An axis-aligned square park of `sidePx` on-screen size at `zoom`. */
function park(name: string, sidePx: number, zoom: number, center: WorldPoint): AreaFeature {
  const half = sidePx / 2 / scaleFor(zoom);
  const [cx, cy] = center;
  return {
    name,
    rings: [
      [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
      ],
    ],
  };
}

function geometry(parts: Partial<MapGeometry>): MapGeometry {
  return { streets: [], transit: [], rivers: [], water: [], parks: [], places: [], ...parts };
}

function labelsAt(zoom: number, parts: Partial<MapGeometry>) {
  return selectMapLabels(packGeometry(geometry(parts)), specAt(zoom));
}

describe('selectMapLabels — class tiers', () => {
  it('labels a motorway well before a residential street', () => {
    const zoom = 12;
    const found = labelsAt(zoom, {
      streets: [
        street({ name: 'Interstate 5', roadClass: 4, lengthPx: 900, zoom }),
        street({
          name: 'Bellevue Place East',
          roadClass: 1,
          lengthPx: 900,
          zoom,
          start: [0.5, 0.52],
        }),
      ],
    });

    expect(found.map((l) => l.text)).toEqual(['INTERSTATE 5']);
  });

  it('adds the residential name once its tier is reached', () => {
    const zoom = LABEL_MIN_ZOOM[1];
    const found = labelsAt(zoom, {
      streets: [street({ name: 'Bellevue Place East', roadClass: 1, lengthPx: 900, zoom })],
    });

    expect(found.map((l) => l.text)).toEqual(['BELLEVUE PLACE EAST']);
  });

  it('never names a class the road LOD has already dropped from the mask', () => {
    // Class 0 draws from z13.5 and is named from z15.5 — at z14 it draws, unnamed.
    const found = labelsAt(14, {
      streets: [street({ name: 'Service Alley', roadClass: 0, lengthPx: 900, zoom: 14 })],
    });

    expect(found).toEqual([]);
  });
});

describe('selectMapLabels — fit gate', () => {
  it('drops a name longer than the road it sits on', () => {
    const zoom = 15;
    const text = 'EAST INTERLAKEN BOULEVARD';
    const tooShort = labelWidthPx(text) * 0.5;
    const roomy = labelWidthPx(text) * 2;

    expect(
      labelsAt(zoom, {
        streets: [
          street({ name: 'East Interlaken Boulevard', roadClass: 2, lengthPx: tooShort, zoom }),
        ],
      })
    ).toEqual([]);

    expect(
      labelsAt(zoom, {
        streets: [
          street({ name: 'East Interlaken Boulevard', roadClass: 2, lengthPx: roomy, zoom }),
        ],
      }).map((l) => l.text)
    ).toEqual([text]);
  });
});

describe('selectMapLabels — one label per name', () => {
  it('collapses a road split across tiles into its longest fragment', () => {
    const zoom = 15;
    const found = labelsAt(zoom, {
      streets: [
        street({ name: '15th Ave E', roadClass: 2, lengthPx: 200, zoom, start: [0.4, 0.5] }),
        street({ name: '15th Ave E', roadClass: 2, lengthPx: 900, zoom, start: [0.5, 0.5] }),
        street({ name: '15th Ave E', roadClass: 2, lengthPx: 300, zoom, start: [0.6, 0.5] }),
      ],
    });

    expect(found).toHaveLength(1);
    // The 900px fragment starting at x=0.5 puts the midpoint past its start.
    expect(found[0].world[0]).toBeGreaterThan(0.5);
  });
});

describe('selectMapLabels — collision', () => {
  it('keeps the higher-class road when two names would overlap', () => {
    const zoom = 15;
    const found = labelsAt(zoom, {
      streets: [
        street({ name: 'Minor Way', roadClass: 1, lengthPx: 900, zoom }),
        street({ name: 'Broad Ave', roadClass: 3, lengthPx: 900, zoom }),
      ],
    });

    expect(found.map((l) => l.text)).toEqual(['BROAD AVE']);
  });

  it('keeps both when they are far enough apart', () => {
    const zoom = 15;
    const found = labelsAt(zoom, {
      streets: [
        street({ name: 'Minor Way', roadClass: 1, lengthPx: 900, zoom, start: [0.5, 0.5] }),
        street({
          name: 'Broad Ave',
          roadClass: 3,
          lengthPx: 900,
          zoom,
          start: [0.5, 0.5 + 400 / scaleFor(zoom)],
        }),
      ],
    });

    expect(found.map((l) => l.text).sort()).toEqual(['BROAD AVE', 'MINOR WAY']);
  });
});

describe('selectMapLabels — orientation', () => {
  it('folds a south-heading road back so its text is never upside down', () => {
    const zoom = 15;
    const [label] = labelsAt(zoom, {
      streets: [
        street({ name: '12th Avenue East', roadClass: 2, lengthPx: 900, zoom, dir: [0, 1] }),
      ],
    });

    expect(Math.abs(label.angle)).toBeLessThanOrEqual(Math.PI / 2 + 1e-9);
  });
});

describe('selectMapLabels — parks', () => {
  it('names a park that is big enough on screen', () => {
    const zoom = 15;
    const found = labelsAt(zoom, {
      parks: [park('Volunteer Park', 300, zoom, [0.5, 0.5])],
    });

    expect(found.map((l) => ({ text: l.text, kind: l.kind }))).toEqual([
      { text: 'VOLUNTEER PARK', kind: 'area' },
    ]);
  });

  it('leaves a sliver of parkland unnamed', () => {
    const zoom = 15;
    expect(labelsAt(zoom, { parks: [park('Tiny Green', 12, zoom, [0.5, 0.5])] })).toEqual([]);
  });

  it('drops park names entirely below the area tier', () => {
    const zoom = AREA_LABEL_MIN_ZOOM - 0.5;
    expect(labelsAt(zoom, { parks: [park('Volunteer Park', 900, zoom, [0.5, 0.5])] })).toEqual([]);
  });

  it('ignores unnamed parkland', () => {
    const zoom = 15;
    const anonymous = { rings: park('x', 300, zoom, [0.5, 0.5]).rings };
    expect(labelsAt(zoom, { parks: [anonymous] })).toEqual([]);
  });
});
