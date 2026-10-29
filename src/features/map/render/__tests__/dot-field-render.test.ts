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
import { buildPaletteLut, computeRegionSpec } from '../../core/region';
import { elevationRgba, groundCode, type ElevationRaster } from '../../core/terrain';
import { DOT_FIELD_SKSL, DOT_MATERIAL_SKSL } from '../dot-field-sksl';
import { dotAtlasSize, packDotFieldUniforms, regionImageLayout } from '../shader-uniforms';

let ck: CanvasKit;
let field: RuntimeEffect;
let material: RuntimeEffect;
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
  const compiledField = ck.RuntimeEffect.Make(DOT_FIELD_SKSL);
  const compiledMaterial = ck.RuntimeEffect.Make(DOT_MATERIAL_SKSL);
  if (!compiledField || !compiledMaterial) throw new Error('Map shaders did not compile');
  field = compiledField;
  material = compiledMaterial;
});

afterAll(() => {
  field?.delete();
  material?.delete();
  if (decoderDescriptor) Object.defineProperty(globalThis, 'TextDecoder', decoderDescriptor);
  else Reflect.deleteProperty(globalThis, 'TextDecoder');
});

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

function render({
  zoom = 10.25,
  viewZoom = zoom,
  pan = 0,
  mask = [0, 255, 0, 255],
  ground = [0, 255, 0, 255],
  terrain = true,
  quality = 1,
}: {
  zoom?: number;
  viewZoom?: number;
  pan?: number;
  mask?: number[];
  ground?: number[];
  terrain?: boolean;
  quality?: number;
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
    const spec = computeRegionSpec(
      {
        center: [home[0] + pan / scale, home[1] + pan / 2 / scale],
        zoom,
      },
      viewport,
      { dataZooms: { min: 0, max: 14 }, pad: 1 }
    );
    const layout = regionImageLayout(spec, quality);
    const uniforms = packDotFieldUniforms({
      region: { spec, elevation: terrain ? elevation : null },
      palette,
      pixelRatio: layout.pixelRatio,
      explorationEnabled: false,
      hasElevation: terrain,
    });
    const inputs = [
      image(new Uint8Array(mask)),
      image(new Uint8Array([255, 0, 0, 255])),
      image(buildPaletteLut(palette), 256, 3),
      image(new Uint8Array(ground)),
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
    const atlasSize = dotAtlasSize(spec);
    const atlasSurface = own(ck.MakeSurface(atlasSize.width, atlasSize.height));
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
      field.makeShaderWithChildren(uniforms, [...inputs.slice(0, 3), atlasShader])
    );
    const surface = own(ck.MakeSurface(layout.width, layout.height));
    paint.setShader(shader);
    const target = surface.getCanvas();
    target.translate(layout.offsetX, layout.offsetY);
    target.drawPaint(paint);
    const regionImage = own(surface.makeImageSnapshot());
    const photo = own(ck.MakeSurface(viewport.width, viewport.height));
    const canvas = photo.getCanvas();
    const view = visibleWorldRect({ center: home, zoom: viewZoom }, viewport);
    canvas.scale(2 ** (viewZoom - zoom), 2 ** (viewZoom - zoom));
    canvas.translate(
      -(view.minX - layout.rect.minX) * scale,
      -(view.minY - layout.rect.minY) * scale
    );
    canvas.scale(1 / layout.pixelRatio, 1 / layout.pixelRatio);
    canvas.drawImageOptions(regionImage, 0, 0, ck.FilterMode.Linear, ck.MipmapMode.None);
    const snapshot = own(photo.makeImageSnapshot());
    const pixels = snapshot.readPixels(0, 0, {
      width: viewport.width,
      height: viewport.height,
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

describe('real CanvasKit map shaders', () => {
  it.each([
    { name: 'mountain', terrain: true },
    { name: 'canopy', terrain: false },
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
