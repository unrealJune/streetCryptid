import { useCallback, useSyncExternalStore } from 'react';

/**
 * What the island says about the map: where the camera is and how much of it you have explored.
 *
 * A store rather than React state on the map, because it changes mid-gesture. The engine writes
 * it at every live camera update (`useMapEngine`'s `track`) and nothing on the map reads it, so a
 * pan or a pinch re-renders only the components subscribed to the value that actually changed —
 * the coverage percentage re-renders the ME body, not the map's whole drawing tree. Before this,
 * each update was a render of `MapView` and of the screen around it.
 */
export interface LiveReadout {
  /** Explored fraction of the sectors in view at the LIVE camera, 0–1, in whole percents. */
  readonly coverage: number;
  /**
   * The same fraction as of the last commit (or exploration/viewport change), never mid-gesture —
   * for consumers whose re-render is expensive and who can wait until the finger lifts, like the
   * map's own accessibility label.
   */
  readonly settledCoverage: number;
  /**
   * Whether a coverage percentage means anything at the live zoom. False below the
   * display-resolution band, where `coverage` is a placeholder 0 — chrome hides the readout and
   * the screen pins the drawer collapsed.
   */
  readonly sectorsVisible: boolean;
  /** Nearest prominent place name to the live camera center, or null. */
  readonly placeName: string | null;
  /**
   * The place name at the last committed camera — like `settledCoverage`, for consumers whose
   * re-render is expensive. The map screen's accessibility label reads this one: subscribed to the
   * live name, every neighbourhood a pan crossed re-rendered the whole screen mid-gesture.
   */
  readonly settledPlaceName: string | null;
}

export interface LiveReadoutStore {
  get(): LiveReadout;
  /** Merge `next` in; listeners hear about it only if a field actually changed. */
  set(next: Partial<LiveReadout>): void;
  subscribe(listener: () => void): () => void;
}

const INITIAL: LiveReadout = {
  coverage: 0,
  settledCoverage: 0,
  sectorsVisible: true,
  placeName: null,
  settledPlaceName: null,
};

/** Whole percents: the finest step the island can show, so finer changes notify nobody. */
export function quantizeCoverage(coverage: number): number {
  return Math.round(coverage * 100) / 100;
}

export function createLiveReadoutStore(initial: LiveReadout = INITIAL): LiveReadoutStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(next) {
      let changed = false;
      for (const key of Object.keys(next) as (keyof LiveReadout)[]) {
        if (next[key] !== undefined && next[key] !== current[key]) changed = true;
      }
      if (!changed) return;
      current = { ...current, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One field (or a primitive derived from the readout), re-rendering only when that value changes.
 * The selector must return a primitive — an object would be a new snapshot every read.
 */
export function useLiveReadout<T extends string | number | boolean | null>(
  store: LiveReadoutStore,
  select: (readout: LiveReadout) => T
): T {
  const getSnapshot = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
