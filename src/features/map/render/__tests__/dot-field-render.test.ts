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
import { ROAD_VALUES, roadWidthFor } from '../../core/road-lod';
import type { RoadClass, Viewport, WorldPoint } from '../../core/types';
import { packGeometry } from '../../tiles/packed-geometry';
import { DOT_FIELD_SKSL, DOT_MATERIAL_SKSL } from '../dot-field-sksl';
import { buildMaskPaths } from '../mask-paths';
import { dotAtlasSize, packDotFieldUniforms, regionImageLayout } from '../shader-uniforms';

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
  size = viewport,
  viewCenter = home,
  fieldSource = DOT_FIELD_SKSL,
}: {
  zoom?: number;
  viewZoom?: number;
  pan?: number;
  mask?: Texture;
  ground?: Texture;
  terrain?: boolean | ElevationRaster;
  quality?: number;
  cells?: Texture;
  explorationEnabled?: boolean;
  size?: Viewport;
  viewCenter?: WorldPoint;
  fieldSource?: string;
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
    const dem = terrain === true ? elevation : terrain || null;
    const uniforms = packDotFieldUniforms({
      region: { spec, elevation: dem },
      palette,
      pixelRatio: layout.pixelRatio,
      explorationEnabled,
      hasElevation: dem !== null,
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
      dem
        ? image(elevationRgba(dem), dem.width, dem.height)
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
    const atlasSize = dotAtlasSize(spec, layout.pixelRatio);
    const atlasSurface = own(ck.MakeSurface(atlasSize.width, atlasSize.height));
    const material = compile(DOT_MATERIAL_SKSL);
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
      compile(fieldSource).makeShaderWithChildren(uniforms, [...inputs.slice(0, 3), atlasShader])
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

/** Narrow-band excess above the local spectral floor of the filtered grain. */
function carrierExcess(pixels: Uint8Array, size: Viewport): number {
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
    const amplitudes = [0];
    for (let k = 1; k <= n / 2; k++) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i++) {
        const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        re += (values[i] - mean) * window * Math.cos((2 * Math.PI * k * i) / n);
        im += (values[i] - mean) * window * Math.sin((2 * Math.PI * k * i) / n);
      }
      amplitudes.push((4 * Math.hypot(re, im)) / n);
    }
    for (let k = Math.ceil(n * 0.12); k < amplitudes.length; k++) {
      // Circle footprints filter grain: its low-frequency floor is not the
      // Nyquist floor. Exclude the candidate's Hann lobe from its neighbourhood.
      const neighbours = amplitudes
        .slice(Math.max(1, k - 8), Math.min(amplitudes.length, k + 9))
        .filter((_, i) => Math.abs(Math.max(1, k - 8) + i - k) > 2)
        .sort((a, b) => a - b);
      peak = Math.max(peak, amplitudes[k] - 3 * neighbours[Math.floor(neighbours.length / 2)]);
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

function localContrast(pixels: Uint8Array, size: Viewport): number {
  let sum = 0;
  for (let y = 1; y < size.height - 1; y++)
    for (let x = 1; x < size.width - 1; x++) {
      const i = (y * size.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const neighbours =
          pixels[i - 4 + c] +
          pixels[i + 4 + c] +
          pixels[i - size.width * 4 + c] +
          pixels[i + size.width * 4 + c];
        sum += Math.abs(pixels[i + c] - neighbours / 4);
      }
    }
  return sum / ((size.width - 2) * (size.height - 2) * 3);
}

function roadMask(zoom: number, roadClass: RoadClass, slope: number): Texture {
  const scale = scaleFor(zoom);
  const geometry = packGeometry({
    streets: [
      {
        roadClass,
        points: [-300, 300].map((y): WorldPoint => [
          home[0] + (y * slope) / scale,
          home[1] + y / scale,
        ]),
      },
    ],
    parks: [],
    water: [],
    rivers: [],
    transit: [],
    places: [],
  });
  return (spec) => {
    const width = roadWidthFor(roadClass, zoom);
    if (width === null) throw new Error('Road fixture is below its visibility zoom');
    const surface = ck.MakeSurface(spec.maskWidth, spec.maskHeight);
    const path = ck.Path.MakeFromSVGString(buildMaskPaths(geometry, spec).streets[roadClass]);
    if (!surface || !path) throw new Error('Road mask allocation failed');
    const paint = new ck.Paint();
    const canvas = surface.getCanvas();
    canvas.clear(ck.BLACK);
    paint.setAntiAlias(true);
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeWidth(width);
    paint.setColor(ck.Color(ROAD_VALUES[roadClass], 0, 0, 1));
    canvas.drawPath(path, paint);
    const snapshot = surface.makeImageSnapshot();
    try {
      const bytes = snapshot.readPixels(0, 0, {
        width: spec.maskWidth,
        height: spec.maskHeight,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      });
      if (!(bytes instanceof Uint8Array)) throw new Error('Road mask readback failed');
      return { bytes: new Uint8Array(bytes), width: spec.maskWidth, height: spec.maskHeight };
    } finally {
      snapshot.delete();
      paint.delete();
      path.delete();
      surface.delete();
    }
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
    const before = render(options);
    const after = render({ ...options, pan: -17.25 });
    const interior = (pixels: Uint8Array) =>
      pixels.filter((_, i) => {
        const x = Math.floor(i / 4) % viewport.width;
        const y = Math.floor(i / 4 / viewport.width);
        return x > 0 && y > 0 && x < viewport.width - 1 && y < viewport.height - 1;
      });
    // Only the outer interpolated pixel can clamp against the bitmap edge.
    expect(meanDifference(before, after)).toBeLessThan(0.5);
    expect(meanDifference(interior(before), interior(after))).toBeLessThan(0.05);
  });

  it('does not shift broad mountain shading across an integer dot-detail boundary', () => {
    const size = { width: 128, height: 128 };
    const before = render({ zoom: 11.99, viewZoom: 12, size });
    const after = render({ zoom: 12.01, viewZoom: 12, size });
    // Average out the deliberately finer stipple, not the relief or its contours.
    const blocks = (pixels: Uint8Array) => {
      const span = 32;
      const columns = size.width / span;
      const rows = size.height / span;
      const means = new Uint8Array(columns * rows * 4);
      for (let by = 0; by < rows; by++)
        for (let bx = 0; bx < columns; bx++) {
          for (let c = 0; c < 3; c++) {
            let sum = 0;
            for (let y = 0; y < span; y++)
              for (let x = 0; x < span; x++) {
                sum += pixels[((by * span + y) * size.width + bx * span + x) * 4 + c];
              }
            means[(by * columns + bx) * 4 + c] = Math.round(sum / (span * span));
          }
        }
      return means;
    };
    expect(meanDifference(blocks(before), blocks(after))).toBeLessThan(3);
  });
});

describe('four-site compositing', () => {
  // Every site that could reach a fragment: the wash stays on its four, so only a dot from the
  // outer ring could change a pixel, and the claim is that none can.
  const reference = DOT_FIELD_SKSL.replaceAll('= 0.0; dy <= 1.0;', '= -1.0; dy <= 2.0;')
    .replaceAll('= 0.0; dx <= 1.0;', '= -1.0; dx <= 2.0;')
    .replace(
      'float w = mix(1.0 - f.x, f.x, dx) * mix(1.0 - f.y, f.y, dy);',
      `float w = dx >= 0.0 && dx <= 1.0 && dy >= 0.0 && dy <= 1.0
        ? mix(1.0 - f.x, f.x, dx) * mix(1.0 - f.y, f.y, dy) : 0.0;`
    );

  it.each([
    { zoom: 13.16, quality: 0.25, fog: true, mask: [255, 0, 0, 255] },
    { zoom: 16.5, quality: 1, fog: false, mask: [255, 0, 0, 255] },
    { zoom: 10.25, quality: 1, fog: true, mask: [0, 255, 0, 255] },
    { zoom: 10.25, quality: 1, fog: false, mask: [0, 255, 0, 255] },
    { zoom: 13.16, quality: 0.65, fog: false, mask: [0, 255, 0, 255] },
    { zoom: 12.25, quality: 1, fog: true, mask: [0, 0, 255, 255] },
    { zoom: 12.25, quality: 1, fog: false, mask: [0, 0, 0, 255], terrain: true },
  ])('matches every reachable neighbour at z$zoom, quality=$quality, fog=$fog', (c) => {
    expect(reference).not.toBe(DOT_FIELD_SKSL);
    const options = { terrain: false, ...c, explorationEnabled: c.fog, cells: [0, 0, 0, 255] };
    expect(render(options)).toEqual(render({ ...options, fieldSource: reference }));
  });
});

describe('visible stipple without a screen-door carrier', () => {
  const size = { width: 96, height: 96 };

  it.each([4, 8])('distinguishes a period-%s mesh from visible irregular grain', (period) => {
    let seed = 41;
    const grain = new Uint8Array(size.width * size.height * 4);
    const mesh = new Uint8Array(grain.length);
    for (let i = 0; i < grain.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const value = 128 + (seed / 2 ** 32 - 0.5) * 32;
      const periodic = 6 * Math.cos((2 * Math.PI * ((i / 4) % size.width)) / period);
      for (let c = 0; c < 3; c++) {
        grain[i + c] = value;
        mesh[i + c] = value + periodic;
      }
    }
    expect(localContrast(grain, size)).toBeGreaterThan(5);
    expect(carrierExcess(grain, size)).toBeLessThan(0.7);
    expect(carrierExcess(mesh, size)).toBeGreaterThan(4);
  });

  it('does not mistake filtered random grain for a periodic mesh', () => {
    let seed = 41;
    const noise = new Float64Array(size.width * size.height);
    for (let i = 0; i < noise.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      noise[i] = 128 + (seed / 2 ** 32 - 0.5) * 64;
    }
    const grain = new Uint8Array(noise.length * 4);
    const mesh = new Uint8Array(grain.length);
    for (let y = 0; y < size.height; y++)
      for (let x = 0; x < size.width; x++) {
        let value = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const ix = (x + dx + size.width) % size.width;
            const iy = (y + dy + size.height) % size.height;
            value += (noise[iy * size.width + ix] * (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1)) / 16;
          }
        for (let c = 0; c < 3; c++) {
          grain[(y * size.width + x) * 4 + c] = value;
          mesh[(y * size.width + x) * 4 + c] = value + 6 * Math.cos((2 * Math.PI * x) / 8);
        }
      }
    expect(localContrast(grain, size)).toBeGreaterThan(1);
    expect(carrierExcess(grain, size)).toBeLessThan(0.7);
    expect(carrierExcess(mesh, size)).toBeGreaterThan(4);
  });

  it.each([
    { zoom: 12.25, fog: false, viewDelta: 0, water: false },
    { zoom: 12.25, fog: true, viewDelta: 0, water: false },
    { zoom: 13.16, fog: false, viewDelta: 0, water: false },
    { zoom: 13.16, fog: true, viewDelta: 0, water: false },
    { zoom: 13.16, fog: false, viewDelta: 0.4, water: false },
    { zoom: 13.16, fog: true, viewDelta: 0.4, water: false },
    { zoom: 13.16, fog: false, viewDelta: -0.4, water: false },
    { zoom: 16.5, fog: false, viewDelta: 0, water: false },
    { zoom: 12.25, fog: true, viewDelta: 0, water: true },
  ])(
    'retains grain at z$zoom fog=$fog live+$viewDelta water=$water',
    ({ zoom, fog, viewDelta, water }) => {
      const options = {
        zoom,
        viewZoom: zoom + viewDelta,
        size,
        explorationEnabled: fog,
        cells: [0, 0, 0, 255],
        mask: water ? [0, 0, 255, 255] : [0, 255, 0, 255],
        terrain: false,
      };
      const pixels = render(options);
      expect(localContrast(pixels, size)).toBeGreaterThan(1);
      expect(carrierExcess(pixels, size)).toBeLessThan(0.7);
      expect(meanDifference(pixels, render({ ...options, pan: 17.25 }))).toBeLessThan(0.1);
      if (!fog) {
        expect(render({ ...options, explorationEnabled: true, cells: [255, 0, 0, 255] })).toEqual(
          pixels
        );
      }
    }
  );

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

describe('finite-width roads, not a solid red mask', () => {
  it.each([
    { zoom: 12.25, fog: false },
    { zoom: 13.16, fog: false },
    { zoom: 13.5, fog: false },
    { zoom: 15, fog: false },
    { zoom: 16.5, fog: false },
    { zoom: 19, fog: false },
    { zoom: 12.25, fog: true },
    { zoom: 13.16, fog: true },
    { zoom: 16.5, fog: true },
  ])('keeps roads connected at z$zoom fog=$fog', ({ zoom, fog }) => {
    const size = { width: 64, height: 64 };
    for (const roadClass of [1, 3] as const) {
      if (roadWidthFor(roadClass, zoom) === null) continue;
      for (const slope of [0, 0.4]) {
        const pixels = render({
          zoom,
          size,
          terrain: false,
          mask: roadMask(zoom, roadClass, slope),
          explorationEnabled: fog,
          cells: [0, 0, 0, 255],
        });
        const ink: number[] = [];
        for (let y = 8; y < size.height - 8; y++) {
          const center = Math.round(size.width / 2 + (y + 0.5 - size.height / 2) * slope);
          let sum = 0;
          for (let x = center - 1; x <= center + 1; x++) {
            const i = (y * size.width + x) * 4;
            sum +=
              (palette.bg[0] -
                pixels[i] +
                palette.bg[1] -
                pixels[i + 1] +
                palette.bg[2] -
                pixels[i + 2]) /
              3;
          }
          ink.push(sum / 3);
        }
        const mean = ink.reduce((sum, value) => sum + value, 0) / ink.length;
        expect(mean).toBeGreaterThan(fog ? 2 : 20);
        expect(Math.min(...ink)).toBeGreaterThan(mean * 0.65);
        if (slope === 0) expect(Math.max(...ink) - Math.min(...ink)).toBeLessThan(mean * 0.12);
      }
    }
  });
});

describe('terrain continuity through material boundaries', () => {
  const level = (metres: number): ElevationRaster => ({
    ...elevation,
    metres: new Float32Array(elevation.width * elevation.height).fill(metres),
  });

  it.each([3, 4])('retains the same absolute contour on ground kind %s', (kind) => {
    const options = {
      zoom: 13,
      size: { width: 64, height: 64 },
      mask: [0, 0, 0, 255],
      ground: [groundCode(kind), 0, 0, 255],
    };
    const line = channelMeans(render({ ...options, terrain: level(2000) }));
    const between = channelMeans(render({ ...options, terrain: level(2025) }));
    expect(
      line.reduce((sum, value, c) => sum + Math.abs(value - between[c]), 0) / 3
    ).toBeGreaterThan(8);
  });

  it('does not paint an artificial green park-edge band above the treeline', () => {
    const options = { zoom: 13.16, terrain: level(3000) };
    expect(render({ ...options, ground: [0, 0, 0, 255] })).toEqual(
      render({ ...options, ground: [0, 255, 0, 255] })
    );
  });

  it.each([false, true])(
    'uses the same alpine rock on either side of a park boundary, fog=%s',
    (fog) => {
      const options = {
        zoom: 13.16,
        terrain: level(3025),
        explorationEnabled: fog,
        cells: [0, 0, 0, 255],
      };
      expect(render({ ...options, mask: [0, 255, 0, 255], ground: [0, 255, 0, 255] })).toEqual(
        render({ ...options, mask: [0, 0, 0, 255], ground: [groundCode(3), 0, 0, 255] })
      );
    }
  );

  it('keeps alpine relief at street zoom even without a ground-cover polygon', () => {
    const options = {
      zoom: 16.5,
      mask: [0, 0, 0, 255],
      ground: [0, 0, 0, 255],
      size: { width: 64, height: 64 },
    };
    expect(
      meanDifference(
        render({ ...options, terrain: level(3000) }),
        render({ ...options, terrain: level(3012) })
      )
    ).toBeGreaterThan(8);
  });
});
