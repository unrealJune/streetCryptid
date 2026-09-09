import { visibleWorldRect } from '../camera';
import { H3_DISPLAY_RES, H3_MIN_RENDER_ZOOM, resForZoom } from '../cell-ladder';
import { createExplorationIndex } from '../exploration-index';
import { createH3Grid, realH3 } from '../h3-grid';
import { latLonToWorld } from '../mercator';
import {
  coverageInView,
  coverageMeasurable,
  friendPlaceName,
  nearestPlaceName,
  placeNameInRegion,
} from '../readout';
import type { CameraState, Place, Viewport, WorldPoint } from '../types';

describe('nearestPlaceName', () => {
  const center: WorldPoint = [0.5, 0.5];

  it('returns null when there are no places', () => {
    expect(nearestPlaceName([], center)).toBeNull();
  });

  describe('friend locality', () => {
    const self = { lat: 47.62, lon: -122.32 };
    const friend = { lat: 40.71, lon: -74 };
    const places: Place[] = [
      { name: 'Your town', world: latLonToWorld(self), kind: 'city' },
      { name: 'Their town', world: latLonToWorld(friend), kind: 'city' },
    ];

    it('uses the friend coordinates even while the camera is still near you', () => {
      expect(placeNameInRegion(places, { minX: 0, minY: 0, maxX: 1, maxY: 1 }, friend)).toBe(
        'Their town'
      );
    });

    it('does not borrow your locality while their tiles load', () => {
      const p = latLonToWorld(self);
      expect(
        placeNameInRegion(
          [places[0]],
          {
            minX: p[0] - 0.01,
            maxX: p[0] + 0.01,
            minY: p[1] - 0.01,
            maxY: p[1] + 0.01,
          },
          friend
        )
      ).toBeNull();
    });

    it('rejects readouts from the previous selection, old fix, or a friend without a fix', () => {
      const readout = { id: 'friend-a', location: friend, name: 'Their town' };
      expect(friendPlaceName(readout, 'friend-a', friend)).toBe('Their town');
      expect(friendPlaceName(readout, 'friend-b', friend)).toBeNull();
      expect(friendPlaceName(readout, 'friend-a', self)).toBeNull();
      expect(friendPlaceName(readout, 'friend-a', null)).toBeNull();
      expect(friendPlaceName(null, 'friend-a', friend)).toBeNull();
    });
  });

  it('picks the nearest locality by squared world distance', () => {
    const places: Place[] = [
      { name: 'Far', world: [0.6, 0.6], kind: 'city' },
      { name: 'Near', world: [0.51, 0.5], kind: 'suburb' },
    ];
    expect(nearestPlaceName(places, center)).toBe('Near');
  });

  it('ignores kinds that are not localities', () => {
    const places: Place[] = [
      { name: 'Road', world: [0.5, 0.5], kind: 'motorway' },
      { name: 'Hood', world: [0.55, 0.55], kind: 'neighbourhood' },
    ];
    expect(nearestPlaceName(places, center)).toBe('Hood');
  });

  it('returns null when every place is a non-locality', () => {
    const places: Place[] = [{ name: 'Road', world: [0.5, 0.5], kind: 'motorway' }];
    expect(nearestPlaceName(places, center)).toBeNull();
  });
});

describe('coverageInView', () => {
  const grid = createH3Grid(realH3());
  const camera: CameraState = { center: latLonToWorld({ lat: 47.62, lon: -122.32 }), zoom: 15 };
  const viewport: Viewport = { width: 200, height: 200 };
  // Zoom 15 renders the fixed-resolution occupancy cells.
  const visibleCells = grid.cellsInRect(
    visibleWorldRect(camera, viewport),
    resForZoom(camera.zoom)!
  );

  it('is 0 when nothing is explored', () => {
    const index = createExplorationIndex([]);
    expect(coverageInView(index, grid, camera, viewport)).toBe(0);
  });

  it('is 1 when every visible sector is explored', () => {
    const index = createExplorationIndex(visibleCells);
    expect(coverageInView(index, grid, camera, viewport)).toBe(1);
  });

  it('is a proper fraction when partially explored', () => {
    expect(visibleCells.length).toBeGreaterThan(1);
    const index = createExplorationIndex([visibleCells[0]]);
    const cov = coverageInView(index, grid, camera, viewport);
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThan(1);
    expect(cov).toBeCloseTo(1 / visibleCells.length, 10);
  });

  it('disables coverage below the display-resolution band', () => {
    // The layer still DRAWS here (the ladder has coarser rungs) — but presence
    // rolled up to res 8 would report a walk as most of a county, so the number
    // is withheld rather than inflated.
    const zoomedOut: CameraState = { ...camera, zoom: H3_MIN_RENDER_ZOOM - 0.5 };
    expect(resForZoom(zoomedOut.zoom)).not.toBeNull();
    expect(resForZoom(zoomedOut.zoom)).not.toBe(H3_DISPLAY_RES);

    const index = createExplorationIndex(visibleCells);
    expect(coverageInView(index, grid, zoomedOut, viewport)).toBe(0);
  });

  it('is measurable exactly on the display-resolution band', () => {
    expect(coverageMeasurable(H3_MIN_RENDER_ZOOM)).toBe(true);
    expect(coverageMeasurable(H3_MIN_RENDER_ZOOM - 0.01)).toBe(false);
    expect(coverageMeasurable(1)).toBe(false);
  });
});
