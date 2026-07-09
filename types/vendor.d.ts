/**
 * Minimal declarations for untyped dev-only tooling packages, used by the
 * fixture bake script and tile tests (geojson-vt and vt-pbf ship no .d.ts).
 */

declare module 'geojson-vt' {
  export interface GeojsonVtOptions {
    maxZoom?: number;
    indexMaxZoom?: number;
    indexMaxPoints?: number;
    tolerance?: number;
    extent?: number;
    buffer?: number;
  }
  export interface GeojsonVtTile {
    features: unknown[];
  }
  export interface GeojsonVtIndex {
    getTile(z: number, x: number, y: number): GeojsonVtTile | null;
  }
  export default function geojsonvt(
    data: GeoJSON.FeatureCollection | GeoJSON.Feature,
    options?: GeojsonVtOptions
  ): GeojsonVtIndex;
}

declare module 'vt-pbf' {
  import type { GeojsonVtTile } from 'geojson-vt';
  const vtpbf: {
    fromGeojsonVt(
      layers: Record<string, GeojsonVtTile>,
      options?: { version?: number; extent?: number }
    ): Uint8Array;
  };
  export default vtpbf;
}
