import { tryGetIrohLocation } from 'iroh-location';

import { addMapPerfMetric, captureMapPerfMetricScope, perfNow } from '../perf/map-perf';
import type { CellIndex, H3PolygonEnumerator } from './h3-grid';

/** Native h3o polygon enumeration, guarded for web and pre-bindgen iOS binaries. */
export function createNativeH3Enumerator(): H3PolygonEnumerator | null {
  const mod = tryGetIrohLocation();
  if (!mod || typeof mod.h3CellsForPolygon !== 'function') return null;
  const enumerate = mod.h3CellsForPolygon.bind(mod);

  return async (loop, resolution): Promise<CellIndex[]> => {
    const metrics = captureMapPerfMetricScope();
    const started = metrics ? perfNow() : 0;
    const coordinates: number[] = [];
    for (const [lat, lon] of loop) coordinates.push(lat, lon);
    const cells = await enumerate(coordinates, resolution);
    addMapPerfMetric('nativeH3Calls', 1, metrics);
    addMapPerfMetric('nativeH3Cells', cells.length, metrics);
    if (metrics) addMapPerfMetric('nativeH3Ms', perfNow() - started, metrics);
    return cells;
  };
}
