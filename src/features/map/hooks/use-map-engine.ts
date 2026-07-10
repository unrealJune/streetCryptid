import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { CryptidTheme } from '@/constants/cryptid-theme';

import {
  CAMERA_INITIAL_ZOOM,
  CAMERA_MAX_ZOOM,
  CAMERA_MIN_ZOOM,
  HEX_RADIUS_WORLD,
  createMapDataset,
  type MapDataset,
} from '../config';
import { applyViewTransform, clampCamera, scaleFor, type ViewTransform } from '../core/camera';
import { demoExploration } from '../core/exploration';
import { makeViewLimits, type ViewLimits } from '../core/gesture';
import { createHexGrid } from '../core/hex';
import { coverageInView, nearestPlaceName } from '../core/readout';
import { coversView, shouldPrefetchRegion } from '../core/region';
import type { CameraState, LatLon, Viewport, WorldPoint } from '../core/types';
import { latLonToWorld } from '../core/mercator';
import { MapEngine, type MapRegion } from '../engine/map-engine';
import { useMapTheme } from './use-map-theme';

export interface MapEngineState {
  readonly theme: CryptidTheme;
  /** The latest built data region (shader textures). */
  readonly region: MapRegion | null;
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
  /** Hex circumradius in world units — a uniform for the dot-field shader. */
  readonly hexRadius: number;
  /** Discovered fraction of the hex sectors in view, 0–1. */
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
  readonly prefetchAt: (t: ViewTransform) => void;
}

/**
 * Owns the map's DATA state for one screen: dataset selection, demo
 * exploration, the engine lifecycle, and region rebuilds on commit/viewport
 * changes. It never writes the visual transform — the view owns that on the
 * UI thread — so nothing here (build latency, region swaps, re-renders) can
 * ever move the map under the user's finger.
 */
export function useMapEngine(
  viewport: Viewport | null,
  initialCenter: LatLon | null = null
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
  const grid = useMemo(() => createHexGrid(HEX_RADIUS_WORLD), []);
  const exploration = useMemo(() => demoExploration(grid, dataset.home), [grid, dataset]);
  const engine = useMemo(
    () =>
      new MapEngine({
        source: dataset.source,
        grid,
        onTiming: __DEV__
          ? (t) =>
              console.log(
                `[map] region: fetch ${t.fetchMs.toFixed(0)} ms (${t.tiles} tiles) + build ${t.buildMs.toFixed(0)} ms`
              )
          : undefined,
      }),
    [dataset, grid]
  );

  const anchor = useMemo<CameraState>(() => ({ center: home, zoom: CAMERA_INITIAL_ZOOM }), [home]);
  const constraints = useMemo(
    () => ({ bounds: dataset.bounds, minZoom: CAMERA_MIN_ZOOM, maxZoom: CAMERA_MAX_ZOOM }),
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

  // Read the live region imperatively so the build effect can decide to reuse it
  // without taking it as a dependency (which would re-run on every rebuild).
  const regionRef = useRef<MapRegion | null>(null);
  useEffect(() => {
    regionRef.current = region;
  }, [region]);

  useEffect(() => {
    if (!viewport) return;
    const current = regionRef.current;
    const covers = current ? coversView(current.spec, target, viewport) : false;
    const rebuild = !current || shouldPrefetchRegion(current.spec, target, viewport);

    // The data camera follows immediately whenever the region still covers the
    // view; readouts (coverage/place) update without waiting on a build.
    if (covers) setCamera(target);
    if (!rebuild) return;

    let live = true;
    engine
      .buildRegion({ camera: target, viewport, exploration })
      .then((built) => {
        if (!live || !built) return; // superseded builds resolve null
        setRegion(built);
        setCamera(target);
      })
      .catch((error) => {
        console.warn('[map] region build failed:', error);
      });
    return () => {
      live = false;
    };
  }, [engine, target, viewport, exploration]);

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
    (t: ViewTransform) => {
      if (!viewport) return;
      const live = clampCamera(applyViewTransform(anchor, viewport, t), viewport, constraints);
      const current = regionRef.current;
      if (current && !shouldPrefetchRegion(current.spec, live, viewport)) return;
      engine
        .buildRegion({ camera: live, viewport, exploration })
        .then((built) => {
          if (built) setRegion(built); // region only — the committed camera is untouched
        })
        .catch(() => {
          /* a superseded/failed prefetch is harmless; the current layer stays */
        });
    },
    [viewport, anchor, constraints, engine, exploration]
  );

  const coverage = useMemo(
    () => (viewport ? coverageInView(exploration, grid, camera, viewport) : 0),
    [exploration, grid, camera, viewport]
  );

  const placeName = useMemo(
    () => (region ? nearestPlaceName(region.places, camera.center) : null),
    [region, camera]
  );

  return {
    theme,
    region,
    camera,
    anchor,
    limits,
    hexRadius: grid.radius,
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
