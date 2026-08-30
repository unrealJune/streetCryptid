import { H3_DISPLAY_RES } from '../../core/cell-ladder';
import { createH3Grid, realH3 } from '../../core/h3-grid';
import { latLonToWorld } from '../../core/mercator';
import { encodeExplorationBackup } from '../exploration-backup';
import {
  exportExplorationBackup,
  restoreExplorationBackup,
  type ExplorationBackupIo,
} from '../exploration-backup-service';
import { createExplorationStore, InMemoryExplorationDb } from '../exploration-store';

const grid = createH3Grid(realH3());
const cellA = grid.cellAt(latLonToWorld({ lat: 47.62, lon: -122.32 }), H3_DISPLAY_RES);
const cellB = grid.cellAt(latLonToWorld({ lat: 47.64, lon: -122.35 }), H3_DISPLAY_RES);

function makeStore(db = new InMemoryExplorationDb()) {
  return { db, store: createExplorationStore({ grid, openDb: async () => db }) };
}

function io(overrides: Partial<ExplorationBackupIo> = {}): ExplorationBackupIo {
  return {
    share: async () => true,
    pick: async () => null,
    ...overrides,
  };
}

describe('exportExplorationBackup', () => {
  it('shares a document holding every explored cell', async () => {
    const db = new InMemoryExplorationDb();
    db.cells.set(cellA, { firstTs: 1, lastTs: 2 });
    db.cells.set(cellB, { firstTs: 3, lastTs: 4 });
    const { store } = makeStore(db);
    const shared: string[] = [];

    const outcome = await exportExplorationBackup(
      store,
      io({
        share: async (text) => {
          shared.push(text);
          return true;
        },
      })
    );

    expect(outcome).toEqual({ status: 'shared', cells: 2 });
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain(cellA);
    expect(shared[0]).toContain(cellB);
    // Timestamps stay behind.
    expect(shared[0]).not.toContain('firstTs');
    expect(shared[0]).not.toMatch(/\bts\b/);
  });

  it('reports an empty history instead of sharing an empty file', async () => {
    const { store } = makeStore();
    const share = jest.fn(async () => true);
    expect(await exportExplorationBackup(store, io({ share }))).toEqual({ status: 'empty' });
    expect(share).not.toHaveBeenCalled();
  });

  it('reports builds that cannot share', async () => {
    const db = new InMemoryExplorationDb();
    db.cells.set(cellA, { firstTs: 1, lastTs: 1 });
    const { store } = makeStore(db);
    expect(await exportExplorationBackup(store, io({ share: async () => false }))).toEqual({
      status: 'unavailable',
    });
  });
});

describe('restoreExplorationBackup', () => {
  it('folds a backup in and leaves existing history alone', async () => {
    const db = new InMemoryExplorationDb();
    db.cells.set(cellA, { firstTs: 111, lastTs: 222 });
    const { store } = makeStore(db);
    await store.load();

    const outcome = await restoreExplorationBackup(
      store,
      io({ pick: async () => encodeExplorationBackup([cellA, cellB]) })
    );

    expect(outcome).toEqual({ status: 'restored', added: 1, skipped: 1, rejected: 0 });
    expect(db.cells.get(cellA)).toEqual({ firstTs: 111, lastTs: 222 });
    expect(db.cells.get(cellB)).toEqual({ firstTs: 0, lastTs: 0 });
  });

  it('is idempotent across repeated restores', async () => {
    const { store } = makeStore();
    const source = io({ pick: async () => encodeExplorationBackup([cellA, cellB]) });
    await restoreExplorationBackup(store, source);
    expect(await restoreExplorationBackup(store, source)).toEqual({
      status: 'restored',
      added: 0,
      skipped: 2,
      rejected: 0,
    });
  });

  it('reports a cancelled picker as a non-event', async () => {
    const { store } = makeStore();
    expect(await restoreExplorationBackup(store, io())).toEqual({ status: 'canceled' });
  });

  it('surfaces an unreadable file as a user-facing failure', async () => {
    const { store } = makeStore();
    const outcome = await restoreExplorationBackup(store, io({ pick: async () => 'not json' }));
    expect(outcome).toEqual({ status: 'failed', message: expect.any(String) });
  });

  it('survives a picker that throws', async () => {
    const { store } = makeStore();
    const outcome = await restoreExplorationBackup(
      store,
      io({
        pick: async () => {
          throw new Error('denied');
        },
      })
    );
    expect(outcome.status).toBe('failed');
  });
});
