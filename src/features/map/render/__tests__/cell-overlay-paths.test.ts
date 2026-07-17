import { buildCellField } from '../../core/cell-field';
import { createExplorationIndex, demoExploration } from '../../core/exploration-index';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import { computeRegionSpec } from '../../core/region';
import type { CameraState, Viewport } from '../../core/types';
import { cellLatticePath, cellRimPath, cellStateFills } from '../cell-overlay-paths';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });
const camera: CameraState = { center: HOME, zoom: 15 };
const viewport: Viewport = { width: 200, height: 200 };
const spec = computeRegionSpec(camera, viewport, { dataZooms: { min: 0, max: 14 } });

const exploration = createExplorationIndex(grid, demoExploration(grid, HOME));
const field = buildCellField(grid, spec.rect, spec.cellRes, exploration);

describe('cellStateFills', () => {
  const fills = cellStateFills(field, spec);

  it('emits one closed ring per cell, channel-encoded', () => {
    expect(fills).toHaveLength(field.cells.length);
    for (const fill of fills) {
      expect(fill.path.startsWith('M')).toBe(true);
      expect(fill.path.endsWith('Z')).toBe(true);
      expect(fill.color).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
    }
  });

  it('encodes fraction into the R channel', () => {
    const byCell = new Map(field.cells.map((c, i) => [c.cell, fills[i]]));
    const explored = field.cells.find((c) => c.fraction === 1)!;
    const hidden = field.cells.find((c) => c.fraction === 0)!;
    expect(byCell.get(explored.cell)!.color).toMatch(/^rgb\(255,/);
    expect(byCell.get(hidden.cell)!.color).toMatch(/^rgb\(0,/);
  });

  it('projects into mask-pixel space', () => {
    // Every coordinate must land inside (or within a margin cell of) the mask.
    const coords = fills.flatMap((f) => f.path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    expect(Math.max(...coords)).toBeLessThan(Math.max(spec.maskWidth, spec.maskHeight) * 1.2);
  });
});

describe('cellLatticePath / cellRimPath', () => {
  it('lattice covers exactly the not-fully-explored cells', () => {
    const path = cellLatticePath(field, spec);
    const hiddenCount = field.cells.filter((c) => c.fraction < 1).length;
    // One 'M' per ring.
    expect((path.match(/M/g) ?? []).length).toBe(hiddenCount);
  });

  it('rim covers exactly the frontier cells', () => {
    const path = cellRimPath(field, spec);
    const frontierCount = field.cells.filter((c) => c.frontier).length;
    expect(frontierCount).toBeGreaterThan(0);
    expect((path.match(/M/g) ?? []).length).toBe(frontierCount);
  });

  it('is deterministic', () => {
    expect(cellLatticePath(field, spec)).toBe(cellLatticePath(field, spec));
    expect(cellRimPath(field, spec)).toBe(cellRimPath(field, spec));
  });
});
