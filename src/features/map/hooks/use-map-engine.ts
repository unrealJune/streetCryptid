import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import type { LocationFix } from '@/features/social/core/types';
import { createPersistentTrailStorage } from '@/features/social/net/persistence';

import { CAMERA_INITIAL_ZOOM, createMapDataset, type MapDataset } from '../config';
import { applyViewTransform, clampCamera, scaleFor, type ViewTransform } from '../core/camera';
import { makeViewLimits, type ViewLimits } from '../core/gesture';
import { createH3Grid, realH3 } from '../core/h3-grid';
import { coverageInView, nearestPlaceName } from '../core/readout';
import { coversView, shouldPrefetchRegion } from '../core/region';
import type { CameraState, LatLon, Viewport, WorldPoint, WorldRect } from '../core/types';
import { latLonToWorld } from '../core/mercator';
import { MapEngine, type MapRegion } from '../engine/map-engine';
import { emitMapPerfEvent } from '../perf/map-perf';
import {
  createDemoExplorationSource,
  createLiveExplorationSource,
} from '../exploration/exploration-source';
import { createExplorationStore } from '../exploration/exploration-store';
import { useMapTheme } from './use-map-theme';

/** How long the camera must sit still before idle neighbor prefetch kicks in. */
const PREFETCH_IDLE_MS = 1200;

/**
 * A cold region build in flight over an area no retained layer covers — the
 * "3-second blank" window. Drives the loading skeleton (ghost lattice + shimmer)
 * so the user sees the hexes-to-be filling rather than bare background.
 */
export interface PendingLoad {
  readonly rect: WorldRect;
  readonly loaded: number;
  readonly total: number;
}

export interface MapEngineState {
  readonly theme: CryptidTheme;
  /** The latest built data region (shader textures). */
  readonly region: MapRegion | null;
  /**
   * A build is in flight over a not-yet-covered area — drives the loading
   * skeleton. Null whenever a retained layer still covers the view (no blank to
   * paper over) or nothing is building.
   */
  readonly pending: PendingLoad | null;
  /** The committed DATA camera — what regions are built for. Never drives the view. */
  readonly camera: CameraState;
  /**
   * The fixed session anchor camera. The view's live transform is expressed
   * relative to it (identity transform ⇔ camera === anchor), and all layers are
   * drawn in its screen space.
   */
  readonly anchor: CameraState;
  /** Zoom/bounds limits in anchor-space pixels, for the UI-thread clamps. */
  readonly limits: ViewLimits | null;
  /** Explored fraction of the cells in view (ladder-rung aggregated), 0–1. */
  readonly coverage: number;
  /** Nearest prominent place name to the camera center, for the island. */
  readonly placeName: string | null;
  /**
   * Commit the view's current ABSOLUTE transform (anchor → now) as the data
   * camera. Called at gesture/fling end. Absolute, so repeated or reordered
   * commits are idempotent — there is no fold base to race against.
   */
  readonly commit: (t: ViewTransform) => void;
  /**
   * Build the region for a live (mid-gesture/fling) transform and swap it in
   * without advancing the committed camera — keeps long pans loading ahead of
   * the finger. No-op while the current region still has headroom.
   */
  readonly prefetchAt: (t: ViewTransform) => Promise<void>;
}

/**
 * Owns the map's DATA state for one screen: dataset selection, exploration,
 * the engine lifecycle, and region rebuilds on commit/viewport changes. It
 * never writes the visual transform — the view owns that on the UI thread — so
 * nothing here (build latency, region swaps, re-renders) can ever move the map
 * under the user's finger.
 */
export function useMapEngine(
  viewport: Viewport | null,
  initialCenter: LatLon | null = null,
  selfFix: LocationFix | null = null,
  /**
   * Friend locations (world space) to warm during idle, pre-ordered/capped by
   * the caller (selected first, then nearest). Empty by default.
   */
  friendTargets: readonly WorldPoint[] = []
): MapEngineState {
  const theme = useMapTheme();

  const dataset = useMemo(() => createMapDataset(), []);
  const requestedHome = useMemo(
    () => (initialCenter ? latLonToWorld(initialCenter) : null),
    [initialCenter]
  );
  const home = useMemo(
    () =>
      requestedHome && pointInside(requestedHome, dataset.bounds) ? requestedHome : dataset.home,
    [dataset, requestedHome]
  );
  const grid = useMemo(() => createH3Grid(realH3()), []);
  const exploration = useMemo(
    () =>
      dataset.explorationMode === 'live'
        ? createLiveExplorationSource(
            grid,
            createExplorationStore({ grid }),
            createPersistentTrailStorage()
          )
        : createDemoExplorationSource(grid, dataset.home),
    [grid, dataset]
  );

  /** Bumps when cells are added — regions and readouts re-key on it. */
  const [explorationVersion, setExplorationVersion] = useState(0);
  useEffect(
    () => exploration.subscribe(() => setExplorationVersion(exploration.version())),
    [exploration]
  );

  // Live fixes fold in as they arrive; a foreground return re-scans the trail
  // for fixes the background task published while the app was asleep.
  useEffect(() => {
    if (selfFix) exploration.noteSelfFix(selfFix);
  }, [exploration, selfFix]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void exploration.backfill();
    });
    return () => sub.remove();
  }, [exploration]);
  const engine = useMemo(
    () =>
      new MapEngine({
        source: dataset.source,
        grid,
        dataZooms: dataset.dataZooms,
        onTiming: __DEV__
          ? (t) => {
              console.log(
                `[map] region: source ${t.sourceMs.toFixed(0)} ms + merge ${t.mergeMs.toFixed(
                  0
                )} ms + cells ${t.cellFieldMs.toFixed(0)} ms (${t.tiles} tiles)`
              );
              emitMapPerfEvent('region-engine', { ...t });
            }
          : undefined,
      }),
    [dataset, grid]
  );

  const anchor = useMemo<CameraState>(() => ({ center: home, zoom: CAMERA_INITIAL_ZOOM }), [home]);
  const constraints = useMemo(
    () => ({ bounds: dataset.bounds, minZoom: dataset.minZoom, maxZoom: dataset.maxZoom }),
    [dataset]
  );
  const limits = useMemo(
    () => (viewport ? makeViewLimits(anchor, viewport, constraints) : null),
    [anchor, viewport, constraints]
  );

  /** Camera to build regions for next (advances on every commit). */
  const [target, setTarget] = useState<CameraState>(anchor);
  /** Camera whose region is on screen (advances when its build lands). */
  const [camera, setCamera] = useState<CameraState>(anchor);
  const [region, setRegion] = useState<MapRegion | null>(null);
  /** A build in flight over an uncovered area (drives the skeleton). */
  const [pending, setPending] = useState<PendingLoad | null>(null);

  // Read the live region imperatively so the build effect can decide to reuse it
  // without taking it as a dependency (which would re-run on every rebuild).
  const regionRef = useRef<MapRegion | null>(null);
  useEffect(() => {
    regionRef.current = region;
  }, [region]);

  /** Exploration version the on-screen region was built with. */
  const builtVersionRef = useRef(-1);

  useEffect(() => {
    if (!viewport) return;
    const current = regionRef.current;
    const covers = current ? coversView(current.spec, target, viewport) : false;
    // No retained layer covers the target → this swap would flash blank, so it
    // gets the skeleton + hex reveal. Independent of cache state: a fast fling or
    // recenter into cached ground is uncovered too (the prefetch didn't lead it).
    const uncovered = !covers;
    const rebuild =
      !current ||
      shouldPrefetchRegion(current.spec, target, viewport, dataset.dataZooms) ||
      builtVersionRef.current !== explorationVersion;

    // The data camera follows immediately whenever the region still covers the
    // view; readouts (coverage/place) update without waiting on a build.
    if (covers) setCamera(target);
    if (!rebuild) {
      setPending(null); // nothing loading — clear any stale skeleton
      return;
    }

    let live = true;
    engine
      .buildRegion(
        {
          camera: target,
          viewport,
          exploration: exploration.index(),
          explorationVersion,
        },
        (progress) => {
          if (!live) return;
          // Skeleton while an uncovered build is outstanding (cold fetch, or a warm
          // rebuild that would otherwise flash blank), tracking its tile progress.
          // A covered rebuild (e.g. exploration changed) never blanks → no skeleton.
          setPending(
            uncovered
              ? { rect: progress.rect, loaded: progress.loaded, total: progress.total }
              : null
          );
        }
      )
      .then((built) => {
        if (!live || !built) return; // superseded builds resolve null
        builtVersionRef.current = explorationVersion;
        setPending(null);
        setRegion(built);
        setCamera(target);
      })
      .catch((error) => {
        if (live) setPending(null);
        console.warn('[map] region build failed:', error);
      });
    return () => {
      live = false;
    };
  }, [engine, target, viewport, exploration, explorationVersion, dataset]);

  // Idle prefetch: once the on-screen camera has held still for a beat, warm the
  // neighboring regions so the next pan/zoom lands on a cache hit instead of a
  // blank fetch. Any camera change cancels it (aborting the in-flight warm),
  // so it only ever runs while the user is paused — never competing with an
  // active build or the tile they're actually waiting on.
  useEffect(() => {
    if (!viewport) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      // Neighbors first (the likeliest next pan), then friends — so a friend
      // never delays warming the ground the user is about to reach. One shared
      // signal: any camera change (or friends update) aborts the whole chain.
      void (async () => {
        await engine.prefetchAround(camera, viewport, controller.signal);
        await engine.prefetchPoints(friendTargets, camera.zoom, viewport, controller.signal);
      })();
    }, PREFETCH_IDLE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [engine, camera, viewport, friendTargets]);

  const commit = useCallback(
    (t: ViewTransform) => {
      if (!viewport) return;
      const next = clampCamera(applyViewTransform(anchor, viewport, t), viewport, constraints);
      // Absolute commits are idempotent — dedupe to skip identical rebuild churn
      // (pan and pinch each finalize the same gesture).
      setTarget((prev) => (cameraAlmostEqual(prev, next, viewport) ? prev : next));
    },
    [viewport, anchor, constraints]
  );

  const prefetchAt = useCallback(
    (t: ViewTransform): Promise<void> => {
      if (!viewport) return Promise.resolve();
      const live = clampCamera(applyViewTransform(anchor, viewport, t), viewport, constraints);
      const current = regionRef.current;
      if (current && !shouldPrefetchRegion(current.spec, live, viewport, dataset.dataZooms)) {
        return Promise.resolve();
      }
      return engine
        .buildRegion({
          camera: live,
          viewport,
          exploration: exploration.index(),
          explorationVersion,
        })
        .then((built) => {
          if (!built) return;
          // Ahead-of-the-finger prefetch swaps reveal like any other: the shader
          // masks off whatever the current layer already covered, so only the new
          // leading strip hex-loads in and covered ground stays put.
          setRegion(built); // region only — the committed camera is untouched
        })
        .catch(() => {
          /* a superseded/failed prefetch is harmless; the current layer stays */
        });
    },
    [viewport, anchor, constraints, engine, exploration, explorationVersion, dataset]
  );

  const coverage = useMemo(
    () => (viewport ? coverageInView(exploration.index(), grid, camera, viewport) : 0),
    // explorationVersion re-keys the memo: the index is identity-stable but mutable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exploration, explorationVersion, grid, camera, viewport]
  );

  const placeName = useMemo(
    () => (region ? nearestPlaceName(region.places, camera.center) : null),
    [region, camera]
  );

  return {
    theme,
    region,
    pending,
    camera,
    anchor,
    limits,
    coverage,
    placeName,
    commit,
    prefetchAt,
  };
}

function pointInside(point: WorldPoint, bounds: MapDataset['bounds']): boolean {
  return (
    point[0] >= bounds.minX &&
    point[0] <= bounds.maxX &&
    point[1] >= bounds.minY &&
    point[1] <= bounds.maxY
  );
}

/** Same view to within half a screen pixel and a hair of zoom. */
function cameraAlmostEqual(a: CameraState, b: CameraState, viewport: Viewport): boolean {
  if (Math.abs(a.zoom - b.zoom) > 1e-4) return false;
  const s = scaleFor(Math.max(a.zoom, b.zoom));
  return (
    Math.abs(a.center[0] - b.center[0]) * s < 0.5 && Math.abs(a.center[1] - b.center[1]) * s < 0.5
  );
}
