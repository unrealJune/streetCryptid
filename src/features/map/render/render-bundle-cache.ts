import type { MapRegion } from '../engine/map-engine';

/** Exact visual-input equality for safe reuse of an immutable rendered bundle. */
export function sameRegionRenderInput(a: MapRegion, b: MapRegion): boolean {
  const aSpec = a.spec;
  const bSpec = b.spec;
  if (
    aSpec.zoom !== bSpec.zoom ||
    aSpec.tileZoom !== bSpec.tileZoom ||
    aSpec.cellRes !== bSpec.cellRes ||
    aSpec.maskWidth !== bSpec.maskWidth ||
    aSpec.maskHeight !== bSpec.maskHeight ||
    aSpec.nominalSize?.width !== bSpec.nominalSize?.width ||
    aSpec.nominalSize?.height !== bSpec.nominalSize?.height ||
    aSpec.rect.minX !== bSpec.rect.minX ||
    aSpec.rect.minY !== bSpec.rect.minY ||
    aSpec.rect.maxX !== bSpec.rect.maxX ||
    aSpec.rect.maxY !== bSpec.rect.maxY ||
    a.cellField !== b.cellField ||
    // Relief that lands after a region is a new picture of the same geometry.
    (a.elevation ?? null) !== (b.elevation ?? null)
  ) {
    return false;
  }
  // The pixels come from the drawn geometry, not from labels that arrive later.
  const aParts = (a.rasterGeometry ?? a.geometry).parts;
  const bParts = (b.rasterGeometry ?? b.geometry).parts;
  return aParts.length === bParts.length && aParts.every((part, index) => part === bParts[index]);
}

interface CacheEntry<Value> {
  readonly region: MapRegion;
  readonly themeKey: unknown;
  /** Identity of every non-geometry render switch (exploration, map layers…). */
  readonly layerKey: string;
  readonly value: Value;
}

export class RegionRenderCache<Value> {
  private readonly entries: CacheEntry<Value>[] = [];

  constructor(private readonly capacity: number) {}

  get(region: MapRegion, themeKey: unknown, layerKey: string): Value | undefined {
    const index = this.entries.findIndex(
      (entry) =>
        entry.themeKey === themeKey &&
        entry.layerKey === layerKey &&
        sameRegionRenderInput(entry.region, region)
    );
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry.value;
  }

  /** Insert `value`, returning the value it pushed out (the caller owns releasing it). */
  set(region: MapRegion, themeKey: unknown, layerKey: string, value: Value): Value | undefined {
    this.entries.push({ region, themeKey, layerKey, value });
    if (this.entries.length > this.capacity) return this.entries.shift()?.value;
    return undefined;
  }
}
