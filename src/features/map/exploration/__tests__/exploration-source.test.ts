import type { LocationFix } from '@/features/social/core/types';
import { InMemoryTrailStorage, SELF_AUTHOR } from '@/features/social/net/background/trail-store';

import { H3_DISPLAY_RES } from '../../core/cell-ladder';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import { createDemoExplorationSource, createLiveExplorationSource } from '../exploration-source';
import { createExplorationStore, InMemoryExplorationDb } from '../exploration-store';

const grid = createH3Grid(realH3());
const HOME = latLonToWorld({ lat: 47.6205, lon: -122.3169 });

function fixAt(lat: number, lon: number, ts = 1000): LocationFix {
  return { lat, lon, accuracyM: 10, headingDeg: 0, ts };
}

function makeLive(db = new InMemoryExplorationDb(), trail = new InMemoryTrailStorage()) {
  const store = createExplorationStore({ grid, openDb: async () => db });
  return { db, trail, source: createLiveExplorationSource(grid, store, trail) };
}

describe('demo exploration source', () => {
  it('is ready immediately with the deterministic demo territory', async () => {
    const source = createDemoExplorationSource(grid, HOME);
    await source.ready;
    expect(source.index().res10.size).toBeGreaterThan(50);
    expect(source.version()).toBe(0);
    source.noteSelfFix(fixAt(47.62, -122.32)); // no-op
    await source.backfill(); // no-op
    expect(source.version()).toBe(0);
  });
});

describe('live exploration source', () => {
  it('loads persisted cells and backfills the trail on init', async () => {
    const db = new InMemoryExplorationDb();
    db.cells.set(grid.cellAt(HOME, H3_DISPLAY_RES), { firstTs: 1, lastTs: 1 });
    const trail = new InMemoryTrailStorage();
    await trail.put({
      author: SELF_AUTHOR,
      seq: 1,
      fix: fixAt(47.64, -122.35, 2000),
      receivedAt: 2000,
    });

    const { source } = makeLive(db, trail);
    await source.ready;
    expect(source.index().res10.size).toBe(2);
    expect(source.version()).toBeGreaterThan(0);
  });

  it('folds a live fix in, bumps the version, and notifies subscribers', async () => {
    const { source } = makeLive();
    await source.ready;
    const before = source.version();

    let notified = 0;
    source.subscribe(() => notified++);
    source.noteSelfFix(fixAt(47.62, -122.32, 3000));
    await source.ready; // flush microtasks
    await new Promise((r) => setTimeout(r, 0));

    expect(source.index().res10.size).toBe(1);
    expect(source.version()).toBe(before + 1);
    expect(notified).toBe(1);
  });

  it('a duplicate fix neither bumps the version nor notifies', async () => {
    const { source } = makeLive();
    await source.ready;
    source.noteSelfFix(fixAt(47.62, -122.32, 3000));
    await new Promise((r) => setTimeout(r, 0));
    const version = source.version();

    let notified = 0;
    source.subscribe(() => notified++);
    source.noteSelfFix(fixAt(47.62, -122.32, 4000)); // same cell
    await new Promise((r) => setTimeout(r, 0));

    expect(source.version()).toBe(version);
    expect(notified).toBe(0);
  });

  it('backfill() picks up trail points published after init', async () => {
    const { source, trail } = makeLive();
    await source.ready;
    expect(source.index().res10.size).toBe(0);

    await trail.put({
      author: SELF_AUTHOR,
      seq: 1,
      fix: fixAt(47.63, -122.33, 5000),
      receivedAt: 5000,
    });
    await source.backfill();
    expect(source.index().res10.size).toBe(1);
  });

  it('unsubscribe stops notifications', async () => {
    const { source } = makeLive();
    await source.ready;
    let notified = 0;
    const unsub = source.subscribe(() => notified++);
    unsub();
    source.noteSelfFix(fixAt(47.62, -122.32, 3000));
    await new Promise((r) => setTimeout(r, 0));
    expect(notified).toBe(0);
  });
});
