import { visibleWorldRect } from '../camera';
import { createHexGrid } from '../hex';
import { coverageInView, nearestPlaceName } from '../readout';
import type { CameraState, Place, Viewport, WorldPoint } from '../types';

describe('nearestPlaceName', () => {
  const center: WorldPoint = [0.5, 0.5];

  it('returns null when there are no places', () => {
    expect(nearestPlaceName([], center)).toBeNull();
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
  const grid = createHexGrid(0.02);
  const camera: CameraState = { center: [0.5, 0.5], zoom: 3 };
  const viewport: Viewport = { width: 200, height: 200 };
  const visibleCells = grid.cellsIn(visibleWorldRect(camera, viewport));

  it('is 0 when nothing is explored', () => {
    expect(coverageInView(new Set(), grid, camera, viewport)).toBe(0);
  });

  it('is 1 when every visible sector is explored', () => {
    expect(coverageInView(new Set(visibleCells), grid, camera, viewport)).toBe(1);
  });

  it('is a proper fraction when partially explored', () => {
    expect(visibleCells.length).toBeGreaterThan(1);
    const cov = coverageInView(new Set([visibleCells[0]]), grid, camera, viewport);
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThan(1);
    expect(cov).toBeCloseTo(1 / visibleCells.length, 10);
  });
});
