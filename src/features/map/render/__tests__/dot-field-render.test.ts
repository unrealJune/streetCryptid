/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import CanvasKitInit, {
  type CanvasKit,
  type CanvasKitInitOptions,
  type RuntimeEffect,
} from 'canvaskit-wasm';

import { CryptidThemes } from '@/constants/cryptid-theme';
import { scaleFor, visibleWorldRect } from '../../core/camera';
import { buildPaletteLut, computeRegionSpec, type RegionSpec } from '../../core/region';
import { elevationRgba, groundCode, type ElevationRaster } from '../../core/terrain';
import type { Viewport, WorldPoint } from '../../core/types';
import { EMPTY_PACKED } from '../../tiles/packed-geometry';
import {
  DOT_AREA_COVERAGE_SKSL,
  DOT_MATERIAL_SKSL,
  DOT_POINT_MATERIAL_SKSL,
  dotFieldSksl,
} from '../dot-field-sksl';
import {
  DOT_STEP,
  dotAtlasSize,
  dotFieldMode,
  packDotFieldUniforms,
  regionImageLayout,
} from '../shader-uniforms';

let ck: CanvasKit;
const effects = new Map<string, RuntimeEffect>();
const viewport = { width: 32, height: 32 };
const home = [0.162, 0.35] as const;
const palette = CryptidThemes.daybreak.canvas;
const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder');

beforeAll(async () => {
  // CanvasKit also decodes UTF-16; Expo's polyfill supports only UTF-8.
  Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder });
  const options: CanvasKitInitOptions & { wasmBinary: Uint8Array } = {
    wasmBinary: readFileSync(require.resolve('canvaskit-wasm/bin/canvaskit.wasm')),
  };
  ck = await CanvasKitInit(options);
});

afterAll(() => {
  for (const effect of effects.values()) effect.delete();
  if (decoderDescriptor) Object.defineProperty(globalThis, 'TextDecoder', decoderDescriptor);
  else Reflect.deleteProperty(globalThis, 'TextDecoder');
});

function compile(source: string): RuntimeEffect {
  const cached = effects.get(source);
  if (cached) return cached;
  const effect = ck.RuntimeEffect.Make(source);
  if (!effect) throw new Error('Map shader did not compile');
  effects.set(source, effect);
  return effect;
}

const elevation: ElevationRaster = {
  width: 128,
  height: 128,
  rect: {
    minX: home[0] - 0.0005,
    minY: home[1] - 0.0005,
    maxX: home[0] + 0.0005,
    maxY: home[1] + 0.0005,
  },
  metres: Float32Array.from(
    { length: 128 * 128 },
    (_, i) => 2400 + 900 * Math.sin((i % 128) / 11) * Math.cos(Math.floor(i / 128) / 17)
  ),
};

type Texture =
  readonly number[] | ((spec: RegionSpec) => { bytes: Uint8Array; width: number; height: number });

function specFor(zoom: number, pan: number, size: Viewport): RegionSpec {
  const scale = scaleFor(zoom);
  const camera = {
    center: [home[0] + pan / scale, home[1] + pan / 2 / scale] as WorldPoint,
    zoom,
  };
  const spec = computeRegionSpec(camera, size, {
    dataZooms: { min: 0, max: 14 },
    pad: 1,
  });
  // A small crop must still reproduce the phone's capped, fractional bitmap density.
  const phone = computeRegionSpec(
    camera,
    { width: 390, height: 780 },
    {
      dataZooms: { min: 0, max: 14 },
    }
  );
  return { ...spec, nominalSize: phone.nominalSize };
}

function render({
  zoom = 10.25,
  viewZoom = zoom,
  pan = 0,
  mask = [0, 255, 0, 255],
  ground = [0, 255, 0, 255],
  terrain = true,
  quality = 1,
  cells = [255, 0, 0, 255],
  explorationEnabled = false,
  filteredAreas = true,
  size = viewport,
  viewCenter = home,
}: {
  zoom?: number;
  viewZoom?: number;
  pan?: number;
  mask?: Texture;
  ground?: Texture;
  terrain?: boolean;
  quality?: number;
  cells?: Texture;
  explorationEnabled?: boolean;
  filteredAreas?: boolean;
  size?: Viewport;
  viewCenter?: WorldPoint;
}): Uint8Array {
  const resources: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(resource: T | null): T => {
    if (!resource) throw new Error('CanvasKit allocation failed');
    resources.push(resource);
    return resource;
  };
  const image = (bytes: Uint8Array, width = 1, height = 1) =>
    own(
      ck.MakeImage(
        {
          width,
          height,
          colorType: ck.ColorType.RGBA_8888,
          alphaType: ck.AlphaType.Opaque,
          colorSpace: ck.ColorSpace.SRGB,
        },
        bytes,
        width * 4
      )
    );
  try {
    const scale = scaleFor(zoom);
    const spec = specFor(zoom, pan, size);
    const layout = regionImageLayout(spec, quality);
    const mode = { ...dotFieldMode(zoom, EMPTY_PACKED), filteredAreas };
    const uniforms = packDotFieldUniforms({
      region: { spec, elevation: terrain ? elevation : null },
      palette,
      pixelRatio: layout.pixelRatio,
      explorationEnabled,
      hasElevation: terrain,
      filteredAreas,
    });
    const texture = (input: Texture) => {
      if (typeof input !== 'function') return image(new Uint8Array(input));
      const { bytes, width, height } = input(spec);
      return image(bytes, width, height);
    };
    const inputs = [
      texture(mask),
      texture(cells),
      image(buildPaletteLut(palette), 256, 3),
      texture(ground),
      terrain
        ? image(elevationRgba(elevation), elevation.width, elevation.height)
        : image(new Uint8Array([0, 0, 0, 255])),
    ].map((im, i) =>
      own(
        im.makeShaderOptions(
          ck.TileMode.Clamp,
          ck.TileMode.Clamp,
          i >= 2 ? ck.FilterMode.Linear : ck.FilterMode.Nearest,
          ck.MipmapMode.None
        )
      )
    );
    const atlasSize = dotAtlasSize(spec, undefined, filteredAreas);
    const atlasSurface = own(ck.MakeSurface(atlasSize.width, atlasSize.height));
    const material = compile(filteredAreas ? DOT_MATERIAL_SKSL : DOT_POINT_MATERIAL_SKSL);
    const materialShader = own(material.makeShaderWithChildren(uniforms, inputs));
    const paint = own(new ck.Paint());
    paint.setShader(materialShader);
    atlasSurface.getCanvas().drawPaint(paint);
    const atlas = own(atlasSurface.makeImageSnapshot());
    const atlasShader = own(
      atlas.makeShaderOptions(
        ck.TileMode.Clamp,
        ck.TileMode.Clamp,
        ck.FilterMode.Nearest,
        ck.MipmapMode.None
      )
    );
    const shader = own(
      compile(dotFieldSksl(mode)).makeShaderWithChildren(uniforms, [
        ...inputs.slice(0, 3),
        atlasShader,
      ])
    );
    const surface = own(ck.MakeSurface(layout.width, layout.height));
    paint.setShader(shader);
    const target = surface.getCanvas();
    target.translate(layout.offsetX, layout.offsetY);
    target.drawPaint(paint);
    const regionImage = own(surface.makeImageSnapshot());
    const photo = own(ck.MakeSurface(size.width, size.height));
    const canvas = photo.getCanvas();
    const view = visibleWorldRect({ center: viewCenter, zoom: viewZoom }, size);
    canvas.scale(2 ** (viewZoom - zoom), 2 ** (viewZoom - zoom));
    canvas.translate(
      -(view.minX - layout.rect.minX) * scale,
      -(view.minY - layout.rect.minY) * scale
    );
    canvas.scale(1 / layout.pixelRatio, 1 / layout.pixelRatio);
    canvas.drawImageOptions(regionImage, 0, 0, ck.FilterMode.Linear, ck.MipmapMode.None);
    const snapshot = own(photo.makeImageSnapshot());
    const pixels = snapshot.readPixels(0, 0, {
      width: size.width,
      height: size.height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (!(pixels instanceof Uint8Array)) throw new Error('Pixel readback failed');
    return new Uint8Array(pixels);
  } finally {
    for (const resource of resources.reverse()) resource.delete();
  }
}

function meanDifference(a: Uint8Array, b: Uint8Array): number {
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 !== 3) difference += Math.abs(a[i] - b[i]);
  }
  return difference / ((a.length / 4) * 3);
}

function channelMeans(pixels: Uint8Array): number[] {
  const sums = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sums[c] += pixels[i + c];
  return sums.map((sum) => sum / (pixels.length / 4));
}

/** Coherent row/column carriers, excluding broad geographic shading. */
function carrierPeak(pixels: Uint8Array, size: Viewport): number {
  const rows = new Float64Array(size.height);
  const columns = new Float64Array(size.width);
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const i = (y * size.width + x) * 4;
      const value = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;
      rows[y] += value / size.width;
      columns[x] += value / size.height;
    }
  let peak = 0;
  for (const values of [rows, columns]) {
    const n = values.length;
    const mean = values.reduce((sum, value) => sum + value, 0) / n;
    for (let k = Math.ceil(n * 0.12); k <= n / 2; k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        re += (values[i] - mean) * window * Math.cos((2 * Math.PI * k * i) / n);
        im += (values[i] - mean) * window * Math.sin((2 * Math.PI * k * i) / n);
      }
      peak = Math.max(peak, (4 * Math.hypot(re, im)) / n);
    }
  }
  return peak;
}

function splitTexture(left: readonly number[], right: readonly number[]): Texture {
  return (spec) => {
    const width = spec.maskWidth;
    const height = spec.maskHeight;
    const bytes = new Uint8Array(width * height * 4);
    for (let x = 0; x < width; x++) {
      const worldX = spec.rect.minX + ((x + 0.5) / width) * (spec.rect.maxX - spec.rect.minX);
      for (let y = 0; y < height; y++)
        bytes.set(worldX < home[0] ? left : right, (y * width + x) * 4);
    }
    return { bytes, width, height };
  };
}

describe('real CanvasKit map shaders', () => {
  it.each([
    { name: 'mountain', terrain: true },
    { name: 'canopy', terrain: false, zoom: 12.25 },
    { name: 'water', mask: [0, 0, 255, 255] },
    { name: 'rock', mask: [0, 0, 0, 255], ground: [groundCode(3), 0, 0, 255] },
    { name: 'farmland', mask: [0, 0, 0, 255], ground: [groundCode(0), 0, 0, 255] },
    { name: 'background', mask: [0, 0, 0, 255], ground: [0, 0, 0, 255] },
  ])('keeps $name fixed when the rendered region pans over the same camera', (options) => {
    const before = render(options);
    const after = render({ ...options, pan: 17.25 });
    expect(meanDifference(before, after)).toBeLessThan(0.05);
    expect(new Set(before).size).toBeGreaterThan(10);
    expect(before.every((byte, i) => i % 4 !== 3 || byte === 255)).toBe(true);
  });

  it('keeps fine canopy stable with a fractional bitmap density', () => {
    const options = { zoom: 13.16, quality: 0.65, terrain: false };
    expect(meanDifference(render(options), render({ ...options, pan: 17.25 }))).toBeLessThan(0.05);
  });

  it.each([12.151, 13.16, 15])('covers bitmap-edge overhang at minimum density, z%s', (zoom) => {
    const quality = 0.25;
    const layout = regionImageLayout(specFor(zoom, 0, viewport), quality);
    const scale = scaleFor(zoom);
    const viewCenter: WorldPoint = [
      layout.rect.minX + viewport.width / 2 / scale,
      layout.rect.minY + viewport.height / 2 / scale,
    ];
    const options = {
      zoom,
      quality,
      viewCenter,
      terrain: false,
      explorationEnabled: true,
      cells: [0, 0, 0, 255],
    };
    expect(layout.pixelRatio).toBe(0.5);
    expect(meanDifference(render(options), render({ ...options, pan: -17.25 }))).toBeLessThan(0.1);
  });

  it('does not shift broad mountain shading across an integer dot-detail boundary', () => {
    const before = render({ zoom: 11.99, viewZoom: 12 });
    const after = render({ zoom: 12.01, viewZoom: 12 });
    // Average out the deliberately finer stipple, not the relief or its contours.
    const blocks = (pixels: Uint8Array) => {
      const columns = viewport.width / 8;
      const rows = viewport.height / 8;
      const means = new Uint8Array(columns * rows * 4);
      for (let by = 0; by < rows; by++)
        for (let bx = 0; bx < columns; bx++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let y = 0; y < 8; y++)
              for (let x = 0; x < 8; x++) {
                sum += pixels[((by * 8 + y) * viewport.width + bx * 8 + x) * 4 + c];
              }
            means[(by * columns + bx) * 4 + c] = Math.round(sum / 64);
          }
        }
      return means;
    };
    expect(meanDifference(blocks(before), blocks(after))).toBeLessThan(3);
  });
});

describe('area reconstruction without a screen-door carrier', () => {
  const size = { width: 96, height: 96 };

  it.each([
    { zoom: 10.25, explored: 0, viewDelta: 0, water: false },
    { zoom: 12.25, explored: 0, viewDelta: 0, water: false },
    { zoom: 12.25, explored: 1, viewDelta: 0, water: false },
    { zoom: 13.16, explored: 0, viewDelta: 0, water: false },
    { zoom: 13.16, explored: 1, viewDelta: 0, water: false },
    { zoom: 13.16, explored: 0, viewDelta: 0.4, water: false },
    { zoom: 13.16, explored: 1, viewDelta: 0.4, water: false },
    { zoom: 12.25, explored: 0, viewDelta: 0, water: true },
  ])(
    'filters z$zoom e$explored live+$viewDelta water=$water without changing tone',
    ({ zoom, explored, viewDelta, water }) => {
      const options = {
        zoom,
        viewZoom: zoom + viewDelta,
        size,
        explorationEnabled: true,
        cells: [explored * 255, 0, 0, 255],
        mask: water ? [0, 0, 255, 255] : [0, 255, 0, 255],
        terrain: false,
      };
      // The retained point renderer is the original circle-compositing reference.
      const dots = render({ ...options, filteredAreas: false });
      const filtered = render(options);
      const before = carrierPeak(dots, size);
      const after = carrierPeak(filtered, size);
      expect(before).toBeGreaterThan(0.5);
      expect(after).toBeLessThan(0.25);
      expect(after).toBeLessThan(before * 0.15);
      const mean = channelMeans(dots);
      channelMeans(filtered).forEach((value, c) =>
        expect(Math.abs(value - mean[c])).toBeLessThan(2.5)
      );
      expect(meanDifference(filtered, render({ ...options, pan: 17.25 }))).toBeLessThan(0.1);
    }
  );

  it.each([15, 13.16])('preserves the point-only renderer at z%s', (zoom) => {
    for (const explored of [0, 255]) {
      const options = {
        zoom,
        terrain: false,
        explorationEnabled: true,
        cells: [explored, 0, 0, 255],
        mask: [255, 0, 0, 255],
      };
      expect(render(options)).toEqual(render({ ...options, filteredAreas: false }));
    }
  });

  it('does not blur road dots beside a filtered park', () => {
    const options = {
      zoom: 13.16,
      terrain: false,
      size,
      mask: splitTexture([0, 255, 0, 255], [255, 0, 0, 255]),
    };
    const filtered = render(options);
    const dots = render({ ...options, filteredAreas: false });
    for (let y = 0; y < size.height; y++) {
      const start = (y * size.width + size.width / 2 + 8) * 4;
      const end = (y + 1) * size.width * 4;
      expect(filtered.subarray(start, end)).toEqual(dots.subarray(start, end));
    }
  });

  it('keeps water precedence and exploration boundaries stable', () => {
    const options = {
      zoom: 13.16,
      terrain: false,
      size,
      explorationEnabled: true,
      cells: splitTexture([0, 0, 0, 255], [255, 0, 0, 255]),
    };
    const water = render({ ...options, mask: [0, 0, 255, 255] });
    expect(render({ ...options, mask: [0, 255, 255, 255] })).toEqual(water);
    expect(
      meanDifference(water, render({ ...options, mask: [0, 0, 255, 255], pan: 17.25 }))
    ).toBeLessThan(0.1);
  });
});

describe('integrated dot coverage', () => {
  it('matches numerical integration of the actual AA circles to one RGBA8 level', () => {
    const firstRadius = 64;
    const width = 154;
    const levels = 256;
    const height = levels * 2;
    const effect = compile(`${DOT_AREA_COVERAGE_SKSL}
      half4 main(float2 p) {
        bool sparse = p.y >= ${levels}.0;
        float r = (${firstRadius}.0 + floor(p.x)) / 255.0;
        float alpha = mod(floor(p.y), ${levels}.0) / 255.0;
        return half4(float3(areaCoverage(r, alpha, sparse)), 1.0);
      }`);
    const surface = ck.MakeSurface(width, height);
    if (!surface) throw new Error('Coverage surface allocation failed');
    const paint = new ck.Paint();
    const shader = effect.makeShaderWithChildren([], []);
    paint.setShader(shader);
    surface.getCanvas().drawPaint(paint);
    const snapshot = surface.makeImageSnapshot();
    try {
      const pixels = snapshot.readPixels(0, 0, {
        width,
        height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (!(pixels instanceof Uint8Array)) throw new Error('Coverage readback failed');
      let maximumError = 0;
      const samples = 64;
      const { hypot, min, max } = Math;
      for (const sparse of [false, true])
        for (let column = 0; column < width; column++) {
          const radius = (firstRadius + column) / 255;
          const pitch = sparse ? 2 : 1;
          const overlaps = [0, 0, 0, 0, 0];
          for (let y = 0; y < samples; y++)
            for (let x = 0; x < samples; x++) {
              const terms = [1, 0, 0, 0, 0, 0];
              for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++) {
                  const distance = hypot(
                    ((x + 0.5) / samples - 0.5 - dx) * pitch,
                    ((y + 0.5) / samples - 0.5 - dy) * pitch
                  );
                  const coverage = min(1, max(0, DOT_STEP * (radius - distance) + 0.5));
                  for (let j = 5; j > 0; j--) terms[j] += terms[j - 1] * coverage;
                }
              for (let j = 0; j < 5; j++) overlaps[j] += terms[j + 1] / samples / samples;
            }
          for (let row = 0; row < levels; row++) {
            const alpha = row / 255;
            const exact = overlaps.reduce(
              (sum, coefficient, j) => sum + coefficient * alpha ** (j + 1) * (j % 2 ? -1 : 1),
              0
            );
            const actual = pixels[((row + (sparse ? levels : 0)) * width + column) * 4] / 255;
            maximumError = Math.max(maximumError, Math.abs(actual - exact));
          }
        }
      expect(maximumError).toBeLessThan(1 / 255);
    } finally {
      snapshot.delete();
      shader.delete();
      paint.delete();
      surface.delete();
    }
  });
});
