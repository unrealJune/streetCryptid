import type { LocationFix } from '@/features/social/core/types';
import type { TrailStorage } from '@/features/social/net/background/trail-store';

import {
  createExplorationIndex,
  demoExploration,
  type ExplorationIndex,
} from '../core/exploration-index';
import type { H3Grid } from '../core/h3-grid';
import type { WorldPoint } from '../core/types';
import type { ExplorationStore } from './exploration-store';

/**
 * The seam `use-map-engine` consumes for exploration state. Two impls:
 * the demo walks (fixture mode) and the live trail-backed store. The index
 * object is MUTABLE and identity-stable (it can hold 10⁴–10⁵ cells — copying
 * per update would thrash); consumers key re-renders/rebuilds on `version()`.
 */
export interface ExplorationSource {
  /** Resolves once the initial state (load + backfill for live) is folded in. */
  readonly ready: Promise<void>;
  index(): ExplorationIndex;
  /** Bumps whenever cells are added. */
  version(): number;
  subscribe(cb: () => void): () => void;
  /** Fold a live self fix in (accuracy-gated). No-op for the demo source. */
  noteSelfFix(fix: LocationFix): void;
  /** Re-scan the persisted trail (e.g. on foreground). No-op for demo. */
  backfill(): Promise<void>;
}

class Notifier {
  private v = 0;
  private readonly subs = new Set<() => void>();
  version(): number {
    return this.v;
  }
  bump(): void {
    this.v += 1;
    for (const cb of this.subs) cb();
  }
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

/** Fixture-mode source: deterministic demo walks, ready synchronously. */
export function createDemoExplorationSource(grid: H3Grid, home: WorldPoint): ExplorationSource {
  const index = createExplorationIndex(demoExploration(grid, home));
  const notifier = new Notifier();
  return {
    ready: Promise.resolve(),
    index: () => index,
    version: () => notifier.version(),
    subscribe: (cb) => notifier.subscribe(cb),
    noteSelfFix: () => {},
    backfill: async () => {},
  };
}

/**
 * Live source: exploration truth from the durable store, seeded by a trail
 * backfill and extended by live fixes. All writes funnel through the store
 * (which owns idempotence + the accuracy gate); the in-memory index mirrors
 * whatever the store reports as newly explored.
 */
export function createLiveExplorationSource(
  grid: H3Grid,
  store: ExplorationStore,
  trailStorage: TrailStorage
): ExplorationSource {
  const index = createExplorationIndex([]);
  const notifier = new Notifier();

  const fold = (cells: Iterable<string>): void => {
    let added = false;
    for (const cell of cells) if (index.add(cell)) added = true;
    if (added) notifier.bump();
  };

  const backfill = async (): Promise<void> => {
    try {
      fold(await store.backfillFromTrail(trailStorage));
    } catch {
      // A failed scan only delays cells until the next backfill.
    }
  };

  const ready = (async () => {
    fold(await store.load());
    await backfill();
  })();

  return {
    ready,
    index: () => index,
    version: () => notifier.version(),
    subscribe: (cb) => notifier.subscribe(cb),
    noteSelfFix: (fix) => {
      void store
        .recordFix(fix)
        .then((cell) => {
          if (cell) fold([cell]);
        })
        .catch(() => {});
    },
    backfill,
  };
}
