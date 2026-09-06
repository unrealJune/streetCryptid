import { scaleFor } from '../camera';
import {
  AREA_LABEL_MIN_ZOOM,
  HOUSENUMBER_MIN_ZOOM,
  labelWidthPx,
  LABEL_MIN_ZOOM,
  POI_LABEL_MIN_ZOOM,
  poiRankBudget,
  TRANSIT_STOP_MIN_ZOOM,
  selectMapLabels,
} from '../map-labels';
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

describe('selectMapLabels — road class', () => {
  it('tags street labels with their road class and leaves areas untagged', () => {
    const zoom = 15;
    const found = labelsAt(zoom, {
      streets: [street({ name: 'Interstate 5', roadClass: 4, lengthPx: 900, zoom })],
      parks: [park('Volunteer Park', 300, zoom, [0.5, 0.6])],
    });

    expect(found.find((l) => l.kind === 'street')?.roadClass).toBe(4);
    expect(found.find((l) => l.kind === 'area')?.roadClass).toBeUndefined();
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

describe('selectMapLabels — POIs (the building-label source)', () => {
  const poi = (name: string, rank: number, world: WorldPoint) => ({
    name,
    world,
    kind: 'hospital',
    subclass: 'hospital',
    rank,
  });

  it('names nothing below the POI tier', () => {
    const found = labelsAt(POI_LABEL_MIN_ZOOM - 0.01, {
      pois: [poi('Harborview Medical Center', 1, [0.5, 0.5])],
    });
    expect(found).toHaveLength(0);
  });

  it('names a top-ranked landmark at the city tier', () => {
    const found = labelsAt(POI_LABEL_MIN_ZOOM, {
      pois: [poi('Harborview Medical Center', 1, [0.5, 0.5])],
    });
    expect(found.map((l) => l.text)).toEqual(['HARBORVIEW MEDICAL CENTER']);
    expect(found[0].kind).toBe('poi');
    // Points sit upright; only streets follow their geometry.
    expect(found[0].angle).toBe(0);
  });

  it('admits more ranks the further in you zoom', () => {
    expect(poiRankBudget(POI_LABEL_MIN_ZOOM)).toBe(2);
    expect(poiRankBudget(POI_LABEL_MIN_ZOOM + 1)).toBeGreaterThan(
      poiRankBudget(POI_LABEL_MIN_ZOOM)
    );
    expect(poiRankBudget(18)).toBeGreaterThan(poiRankBudget(16));

    // A rank the city tier rejects is admitted once the camera is deep enough.
    const low = poi('ZoomCare', 20, [0.5, 0.5]);
    expect(labelsAt(POI_LABEL_MIN_ZOOM, { pois: [low] })).toHaveLength(0);
    expect(labelsAt(17, { pois: [low] })).toHaveLength(1);
  });

  it('keeps one chip per name when a POI straddles a tile seam', () => {
    const found = labelsAt(17, {
      pois: [
        poi('Seattle Surgery Center', 3, [0.5, 0.5]),
        poi('Seattle Surgery Center', 3, [0.5, 0.5]),
      ],
    });
    expect(found).toHaveLength(1);
  });

  it('routes stops to the transit kind and keeps stations as places', () => {
    const zoom = 17;
    const at = (world: WorldPoint, name: string, kind: string, subclass: string) => ({
      name,
      world,
      kind,
      subclass,
      rank: 1,
    });
    const found = labelsAt(zoom, {
      pois: [
        // Every corner stop is a rank-1 POI named for its intersection, so left
        // among the places they beat real buildings on the tie-break.
        at([0.5, 0.5], '5th Avenue North & Republican Street', 'bus', 'bus_stop'),
        at([0.52, 0.5], 'Terry & Thomas', 'railway', 'tram_stop'),
        // …but a light-rail station is a landmark, not a pole on a corner.
        at([0.48, 0.5], 'Westlake Station', 'railway', 'station'),
      ],
    });
    const byText = new Map(found.map((l) => [l.text, l.kind]));
    expect(byText.get('WESTLAKE STATION')).toBe('poi');
    expect(byText.get('5TH AVENUE NORTH & REPUBLICAN STREET')).toBe('transit');
    expect(byText.get('TERRY & THOMAS')).toBe('transit');
  });

  it('leaves stops unnamed until the transit tier', () => {
    const stop = {
      name: 'Terry & Thomas',
      world: [0.5, 0.5] as WorldPoint,
      kind: 'railway',
      subclass: 'tram_stop',
      rank: 1,
    };
    expect(labelsAt(TRANSIT_STOP_MIN_ZOOM - 0.01, { pois: [stop] })).toHaveLength(0);
    expect(labelsAt(TRANSIT_STOP_MIN_ZOOM, { pois: [stop] }).map((l) => l.kind)).toEqual([
      'transit',
    ]);
  });

  it('never lets a stop displace the building it stands outside', () => {
    const zoom = 17;
    const world: WorldPoint = [0.5, 0.5];
    const found = labelsAt(zoom, {
      pois: [
        { name: 'Terry & Thomas', world, kind: 'railway', subclass: 'tram_stop', rank: 1 },
        { name: 'ACT Theatre', world, kind: 'attraction', subclass: 'theatre', rank: 9 },
      ],
    });
    // Same anchor: the place is placed first even though the stop outranks it.
    expect(found.map((l) => l.text)).toEqual(['ACT THEATRE']);
  });

  it('spends its cap near the camera, not out in the region padding', () => {
    // A region is 3x the viewport, so most of it is off screen. A point label
    // has no length to reach into frame with, so ordering by importance alone
    // spent the whole cap on padding: measured downtown at z17, 1275 candidates
    // were eligible, 14 were placed and none were visible.
    const zoom = 17;
    const spec = specAt(zoom);
    const cx = (spec.rect.minX + spec.rect.maxX) / 2;
    const cy = (spec.rect.minY + spec.rect.maxY) / 2;

    // One important POI far out in the padding, and a crowd of duller ones on
    // top of the camera. The near crowd must win the budget.
    const far = {
      name: 'Far Landmark',
      world: [cx + 0.3, cy + 0.3] as WorldPoint,
      kind: 'x',
      subclass: 'x',
      rank: 1,
    };
    // Spaced far enough apart on screen that the collision pass keeps them all,
    // and numerous enough to exhaust the cap on their own.
    const px = scaleFor(zoom);
    const near = Array.from({ length: 20 }, (_, i) => ({
      name: `Near ${i}`,
      world: [cx + (i % 4) * (70 / px), cy + Math.floor(i / 4) * (25 / px)] as WorldPoint,
      kind: 'x',
      subclass: 'x',
      rank: 5,
    }));

    const texts = labelsAt(zoom, { pois: [far, ...near] }).map((l) => l.text);
    expect(texts.length).toBeGreaterThan(10);
    expect(texts).toContain('NEAR 0');
    // The cap is spent entirely on what is near the camera; the distant rank-1
    // landmark never gets a slot despite being the most important candidate.
    expect(texts).not.toContain('FAR LANDMARK');
  });

  it('outranks a street name it would collide with', () => {
    const zoom = 17;
    const road = street({ name: 'James Street', roadClass: 2, lengthPx: 900, zoom });
    // A street chip sits at its arc-length MIDPOINT, so take the anchor from a
    // street-only pass rather than assuming it is the way's start.
    const [anchor] = labelsAt(zoom, { streets: [road] });
    expect(anchor.kind).toBe('street');

    const found = labelsAt(zoom, {
      pois: [poi('Harborview Medical Center', 1, anchor.world)],
      streets: [road],
    });
    // Same anchor: the POI is placed first and the street chip is rejected.
    expect(found.map((l) => l.kind)).toEqual(['poi']);
  });
});

describe('selectMapLabels — house numbers', () => {
  const number = (n: string, world: WorldPoint) => ({ number: n, world });

  it('draws nothing until the deepest zoom', () => {
    const parts = { houseNumbers: [number('325', [0.5, 0.5])] };
    expect(labelsAt(HOUSENUMBER_MIN_ZOOM - 0.01, parts)).toHaveLength(0);
    expect(labelsAt(HOUSENUMBER_MIN_ZOOM, parts).map((l) => l.text)).toEqual(['325']);
  });

  it('never displaces a name', () => {
    const zoom = HOUSENUMBER_MIN_ZOOM;
    const road = street({ name: 'James Street', roadClass: 2, lengthPx: 900, zoom });
    const [anchor] = labelsAt(zoom, { streets: [road] });

    const found = labelsAt(zoom, {
      houseNumbers: [number('325', anchor.world)],
      streets: [road],
    });
    // The street chip wins the shared anchor; the number is dropped.
    expect(found.map((l) => l.kind)).toEqual(['street']);
  });

  it('keeps the same number at two different addresses', () => {
    const found = labelsAt(HOUSENUMBER_MIN_ZOOM, {
      houseNumbers: [number('1200', [0.2, 0.2]), number('1200', [0.8, 0.8])],
    });
    expect(found).toHaveLength(2);
  });
});
