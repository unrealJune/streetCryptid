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
    aSpec.rect.minX !== bSpec.rect.minX ||
    aSpec.rect.minY !== bSpec.rect.minY ||
    aSpec.rect.maxX !== bSpec.rect.maxX ||
    aSpec.rect.maxY !== bSpec.rect.maxY ||
    a.cellField !== b.cellField ||
    a.geometry.parts.length !== b.geometry.parts.length
  ) {
    return false;
  }
  return a.geometry.parts.every((part, index) => part === b.geometry.parts[index]);
}

interface CacheEntry<Value> {
  readonly region: MapRegion;
  readonly themeKey: unknown;
  readonly explorationEnabled: boolean;
  readonly value: Value;
}

export class RegionRenderCache<Value> {
  private readonly entries: CacheEntry<Value>[] = [];

  constructor(private readonly capacity: number) {}

  get(region: MapRegion, themeKey: unknown, explorationEnabled: boolean): Value | undefined {
    const index = this.entries.findIndex(
      (entry) =>
        entry.themeKey === themeKey &&
        entry.explorationEnabled === explorationEnabled &&
        sameRegionRenderInput(entry.region, region)
    );
    if (index < 0) return undefined;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry.value;
  }

  set(region: MapRegion, themeKey: unknown, explorationEnabled: boolean, value: Value): void {
    this.entries.push({ region, themeKey, explorationEnabled, value });
    if (this.entries.length > this.capacity) this.entries.shift();
  }
}
