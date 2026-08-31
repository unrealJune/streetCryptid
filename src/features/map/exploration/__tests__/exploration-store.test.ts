import type { LocationFix } from '@/features/social/core/types';
import {
  InMemoryTrailStorage,
  SELF_AUTHOR,
  type TrailStorage,
} from '@/features/social/net/background/trail-store';

import { H3_DISPLAY_RES } from '../../core/cell-ladder';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import {
  createExplorationStore,
  EXPLORATION_ACCURACY_MAX_M,
  InMemoryExplorationDb,
} from '../exploration-store';

const grid = createH3Grid(realH3());

function fixAt(lat: number, lon: number, ts = 1000, accuracyM = 10): LocationFix {
  return { lat, lon, accuracyM, headingDeg: 0, ts };
}

function makeStore(db = new InMemoryExplorationDb()) {
  return { db, store: createExplorationStore({ grid, openDb: async () => db }) };
}

async function seedTrail(storage: TrailStorage, fixes: LocationFix[]): Promise<void> {
  for (let i = 0; i < fixes.length; i++) {
    await storage.putSelf({
      author: SELF_AUTHOR,
      seq: i + 1,
      fix: fixes[i],
      receivedAt: fixes[i].ts,
    });
  }
}

describe('recordFix', () => {
  it('records a new cell once and is idempotent after', async () => {
    const { db, store } = makeStore();
    const fix = fixAt(47.62, -122.32, 1000);
    const expected = grid.cellAt(latLonToWorld({ lat: fix.lat, lon: fix.lon }), H3_DISPLAY_RES);

    expect(await store.recordFix(fix)).toBe(expected);
    expect(await store.recordFix({ ...fix, ts: 2000 })).toBeNull(); // already known
    expect(db.cells.size).toBe(1);
  });

  it('preserves first_ts and bumps last_ts on revisit', async () => {
    const { db, store } = makeStore();
    const fix = fixAt(47.62, -122.32, 1000);
    await store.recordFix(fix);
    await store.recordFix({ ...fix, ts: 5000 });
    const row = [...db.cells.values()][0];
    expect(row.firstTs).toBe(1000);
    expect(row.lastTs).toBe(5000);
  });

  it('rejects fixes coarser than the accuracy gate', async () => {
    const { db, store } = makeStore();
    const coarse = fixAt(47.62, -122.32, 1000, EXPLORATION_ACCURACY_MAX_M + 1);
    expect(await store.recordFix(coarse)).toBeNull();
    expect(db.cells.size).toBe(0);
  });

  it('load returns everything previously recorded', async () => {
    const db = new InMemoryExplorationDb();
    await makeStore(db).store.recordFix(fixAt(47.62, -122.32));
    await makeStore(db).store.recordFix(fixAt(47.63, -122.33));
    // A fresh store over the same db sees both cells.
    const loaded = await makeStore(db).store.load();
    expect(loaded.size).toBe(2);
  });

  it('folds legacy res-10 cells into res-9 occupancy on load', async () => {
    const db = new InMemoryExplorationDb();
    const point = latLonToWorld({ lat: 47.62, lon: -122.32 });
    const legacy = grid.cellAt(point, 10);
    await db.insertCell(legacy, 1000);

    const loaded = await makeStore(db).store.load();
    expect(loaded).toEqual(new Set([grid.parentOf(legacy, H3_DISPLAY_RES)]));
  });

  it('ignores cells coarser than the occupancy resolution on load', async () => {
    const db = new InMemoryExplorationDb();
    await db.insertCell(grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), 8), 1000);

    expect(await makeStore(db).store.load()).toEqual(new Set());
  });
});

describe('backfillFromTrail', () => {
  it('folds the whole trail in and advances the cursor past it', async () => {
    const { db, store } = makeStore();
    const trail = new InMemoryTrailStorage();
    await seedTrail(trail, [
      fixAt(47.62, -122.32, 1000),
      fixAt(47.63, -122.33, 2000),
      fixAt(47.62, -122.32, 3000), // revisit — no new cell
    ]);

    const added = await store.backfillFromTrail(trail);
    expect(added).toHaveLength(2);
    expect(await db.getKv('backfill.cursor')).toBe('3001');
  });

  it('resumes strictly after the cursor without rescanning', async () => {
    const { store } = makeStore();
    const trail = new InMemoryTrailStorage();
    const rangeSpy = jest.spyOn(trail, 'selfRange');
    await seedTrail(trail, [fixAt(47.62, -122.32, 1000)]);

    await store.backfillFromTrail(trail);
    expect(rangeSpy).toHaveBeenLastCalledWith(0);

    await trail.putSelf({
      author: SELF_AUTHOR,
      seq: 2,
      fix: fixAt(47.64, -122.35, 4000),
      receivedAt: 4000,
    });
    const added = await store.backfillFromTrail(trail);
    expect(rangeSpy).toHaveBeenLastCalledWith(1001);
    expect(added).toHaveLength(1);
  });

  it('is a no-op on an empty trail and leaves the cursor untouched', async () => {
    const { db, store } = makeStore();
    const added = await store.backfillFromTrail(new InMemoryTrailStorage());
    expect(added).toHaveLength(0);
    expect(await db.getKv('backfill.cursor')).toBeNull();
  });
});

describe('exportCells / importCells', () => {
  it('exports explored cells sorted and without any timing data', async () => {
    const { db, store } = makeStore();
    await store.recordFix(fixAt(47.64, -122.35, 5000));
    await store.recordFix(fixAt(47.62, -122.32, 1000));

    const exported = await store.exportCells();
    expect(exported).toHaveLength(2);
    expect([...exported]).toEqual([...exported].sort());
    expect(new Set(exported)).toEqual(new Set(db.cells.keys()));
  });

  it('adds unknown cells with no timestamp and preserves known ones', async () => {
    const { db, store } = makeStore();
    await store.recordFix(fixAt(47.62, -122.32, 1000));
    const [known] = await store.exportCells();
    const fresh = grid.cellAt(latLonToWorld({ lat: 47.64, lon: -122.35 }), H3_DISPLAY_RES);

    const result = await store.importCells([known, fresh]);

    expect(result.added).toEqual([fresh]);
    expect(result.skipped).toBe(1);
    expect(db.cells.get(known)).toEqual({ firstTs: 1000, lastTs: 1000 });
    expect(db.cells.get(fresh)).toEqual({ firstTs: 0, lastTs: 0 });
  });

  it('folds finer cells to their display-resolution parent and rejects coarser ones', async () => {
    const { store } = makeStore();
    const display = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES);
    const finer = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES + 2);
    const coarser = grid.parentOf(display, H3_DISPLAY_RES - 2);

    const result = await store.importCells([finer, coarser, 'not-a-cell']);

    expect(result.added).toEqual([display]);
    expect(result.rejected).toBe(2);
  });

  it('notifies subscribers so an open map picks a restore up', async () => {
    const { store } = makeStore();
    const seen: string[][] = [];
    const unsubscribe = store.subscribe((added) => seen.push([...added]));
    const cell = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES);

    await store.importCells([cell]);
    expect(seen).toEqual([[cell]]);

    unsubscribe();
    await store.importCells([
      grid.cellAt(latLonToWorld({ lat: 47.64, lon: -122.35 }), H3_DISPLAY_RES),
    ]);
    expect(seen).toHaveLength(1);
  });

  it('does not notify when nothing is new', async () => {
    const { store } = makeStore();
    const cell = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES);
    await store.importCells([cell]);
    const seen: string[][] = [];
    store.subscribe((added) => seen.push([...added]));
    await store.importCells([cell]);
    expect(seen).toHaveLength(0);
  });
});
