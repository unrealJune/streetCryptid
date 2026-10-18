'use no memo'; // react-compiler: keep it away from Skia JSI objects

import type { SkImage } from '@shopify/react-native-skia';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { MapPalette } from '../core/types';
import type { MapRegion } from '../engine/map-engine';
import {
  emitMapPerfEvent,
  isMapPerfRunEnabled,
  perfNow,
  type RegionRenderTiming,
} from '../perf/map-perf';
import { RegionRenderCache } from './render-bundle-cache';
import { makeCellStateImage, makeRegionTextures, renderRegionImage } from './region-shader';

export interface RegionBundle {
  region: MapRegion;
  image: SkImage | null;
  /** The baked cell-state texture — reused by the loading reveal's alpha wipe. */
  cellImage: SkImage | null;
  timing: RegionRenderTiming;
}

export interface RegionBundleOptions {
  readonly palette: MapPalette;
  readonly lutImage: SkImage | null;
  readonly explorationEnabled: boolean;
  readonly highwaysEnabled: boolean;
  readonly transitEnabled: boolean;
  readonly structuresEnabled: boolean;
}

const REGION_RENDER_CACHE_CAPACITY = 3;

/**
 * The newest region, rasterized: its feature textures and its bitmap, built
 * once and cached (`RegionRenderCache`), so the outgoing layer of a swap is
 * never drawn twice.
 *
 * Off the render path, and newest-wins. This used to be a `useMemo` in
 * `MapView`'s render, so every published region — a zoom preview, the stream's
 * coarse stage, its structure stage, the finished tile, a relief upgrade — was
 * rasterized synchronously inside React's render, each one blocking the JS
 * thread for the whole job even when the next region had already landed. Now a
 * region is picked up on the next task, its textures and its bitmap are built
 * in separate tasks (so input, network callbacks and tile decodes interleave),
 * and a region that is superseded before its work starts is never drawn at all.
 * A cache hit still lands synchronously.
 */
export function useRegionBundle(
  region: MapRegion | null,
  options: RegionBundleOptions
): RegionBundle | null {
  const {
    palette,
    lutImage,
    explorationEnabled,
    highwaysEnabled,
    transitEnabled,
    structuresEnabled,
  } = options;
  const cache = useMemo(
    () =>
      new RegionRenderCache<{ image: SkImage | null; cellImage: SkImage | null }>(
        REGION_RENDER_CACHE_CAPACITY
      ),
    []
  );
  const [rendered, setRendered] = useState<RegionBundle | null>(null);
  /** Bumped by every new input: work still queued for an older one drops itself. */
  const generation = useRef(0);
  const renderExploration = explorationEnabled && region?.spec.cellRes !== null;
  const layerKey = `${renderExploration ? 'x' : '-'}${highwaysEnabled ? 'h' : '-'}${
    transitEnabled ? 't' : '-'
  }${structuresEnabled ? 'b' : '-'}`;

  // A cache hit (a region swapped back in, a labels-only stage, a theme flip
  // back) is answered during render, so it swaps in the same frame as before.
  const hit = useMemo<RegionBundle | null>(() => {
    if (!region) return null;
    const cached = cache.get(region, lutImage, layerKey);
    if (!cached) return null;
    const timing = { cacheHit: true, maskMs: 0, cellTextureMs: 0, rasterMs: 0, totalMs: 0 };
    emitMapPerfEvent('region-render', perfDetail(region, timing, null));
    return { region, ...cached, timing };
  }, [region, lutImage, layerKey, cache]);

  useEffect(() => {
    const ticket = ++generation.current;
    if (!region || hit) return;

    const measure = isMapPerfRunEnabled();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (step: () => void) => {
      timers.push(
        setTimeout(() => {
          if (ticket === generation.current) step();
        }, 0)
      );
    };
    later(() => {
      const started = measure ? perfNow() : 0;
      const textures = makeRegionTextures(region, { highways: highwaysEnabled });
      const maskMs = measure ? perfNow() - started : 0;
      const cellStarted = measure ? perfNow() : 0;
      const cellImage = makeCellStateImage(region);
      const cellTextureMs = measure ? perfNow() - cellStarted : 0;
      // The bitmap is its own task: whatever queued behind the textures runs first.
      // Once the textures exist the bitmap is always finished, even if a newer
      // region arrived meanwhile — otherwise a steady stream could starve it.
      timers.push(
        setTimeout(() => {
          const rasterStarted = measure ? perfNow() : 0;
          const image =
            textures.mask && textures.ground && textures.terrain && cellImage && lutImage
              ? renderRegionImage({
                  region,
                  palette,
                  maskImage: textures.mask,
                  groundImage: textures.ground,
                  terrainImage: textures.terrain,
                  hasElevation: textures.hasElevation,
                  cellImage,
                  lutImage,
                  explorationEnabled: renderExploration,
                  transitEnabled,
                  structuresEnabled,
                })
              : null;
          const rasterMs = measure ? perfNow() - rasterStarted : 0;
          const timing = {
            cacheHit: false,
            maskMs,
            cellTextureMs,
            rasterMs,
            totalMs: measure ? perfNow() - started : 0,
          };
          emitMapPerfEvent('region-render', perfDetail(region, timing, textures.hasElevation));
          if (image && cellImage && lutImage)
            cache.set(region, lutImage, layerKey, { image, cellImage });
          // A newer input already on its way replaces this; the cache keeps it either way.
          if (ticket === generation.current) setRendered({ region, image, cellImage, timing });
        }, 0)
      );
    });
    return () => {
      // Only work not yet started is dropped; a bitmap in progress completes (above).
      if (timers.length === 1) clearTimeout(timers[0]);
    };
  }, [
    region,
    hit,
    renderExploration,
    layerKey,
    palette,
    lutImage,
    explorationEnabled,
    highwaysEnabled,
    transitEnabled,
    structuresEnabled,
    cache,
  ]);

  // A hit is the current region. Otherwise the newest bundle seen stays up until
  // its successor is rendered: falling back to an older render here would step
  // the map backwards for the length of a render.
  // (Derive-during-render, the same pattern as `MapView`'s region track.)
  const [shown, setShown] = useState<RegionBundle | null>(null);
  const newest = [hit, rendered, shown].reduce<RegionBundle | null>(
    (best, b) => (b && (!best || b.region.publication > best.region.publication) ? b : best),
    null
  );
  if (newest !== shown) setShown(newest);
  return newest;
}

function perfDetail(region: MapRegion, timing: RegionRenderTiming, hasElevation: boolean | null) {
  return {
    ...timing,
    cells: region.cellField.cells.length,
    maskWidth: region.spec.maskWidth,
    maskHeight: region.spec.maskHeight,
    publication: region.publication,
    zoom: region.spec.zoom,
    tileZoom: region.spec.tileZoom,
    hasElevation,
  };
}
