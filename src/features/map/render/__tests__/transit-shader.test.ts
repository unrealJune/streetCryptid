import CanvasKitInit, { type CanvasKit, type RuntimeEffect } from 'canvaskit-wasm';
import { TextDecoder } from 'node:util';

import { buildPaletteLut } from '../../core/region';
import type { MapRegion } from '../../engine/map-engine';
import { BUILT_IN_MAP_COLOR_SCHEMES } from '../../theme/map-color-schemes';
import { DOT_FIELD_SKSL } from '../dot-field-sksl';
import { packDotFieldUniforms } from '../shader-uniforms';

const SIZE = 32;
const palette = BUILT_IN_MAP_COLOR_SCHEMES[0].light;
const region = {
  spec: {
    rect: { minX: 0, minY: 0, maxX: SIZE / 256, maxY: SIZE / 256 },
    maskWidth: SIZE,
    maskHeight: SIZE,
    zoom: 0,
  },
} as MapRegion;

let kit: CanvasKit;
let effect: RuntimeEffect;

beforeAll(async () => {
  // CanvasKit needs UTF-16 decoding, which Expo's test polyfill does not implement.
  const decoder = globalThis.TextDecoder;
  globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
  try {
    kit = await CanvasKitInit({
      locateFile: () => require.resolve('canvaskit-wasm/bin/canvaskit.wasm'),
    });
  } finally {
    globalThis.TextDecoder = decoder;
  }
  const compiled = kit.RuntimeEffect.Make(DOT_FIELD_SKSL);
  if (!compiled) throw new Error('dot-field shader failed to compile');
  effect = compiled;
});

afterAll(() => effect?.delete());

function render({
  transitEnabled = true,
  ink = [180, 80, 140],
  explored = true,
  explorationEnabled = true,
  reveal = 1,
  highway = false,
}: {
  transitEnabled?: boolean;
  ink?: readonly number[];
  explored?: boolean;
  explorationEnabled?: boolean;
  reveal?: number;
  highway?: boolean;
} = {}): Uint8Array {
  const mask = new Uint8Array(SIZE * SIZE * 4);
  const cells = new Uint8Array(mask.length);
  const transit = new Uint8Array(mask.length);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = (y * SIZE + x) * 4;
      mask[p + 3] = cells[p + 3] = 255;
      cells[p] = explored ? 255 : 0;
      if (y >= 14 && y < 19) {
        if (highway) mask[p] = 245;
        transit.set([...ink, 255], p);
      }
    }
  }
  const image = (data: Uint8Array, width = SIZE, height = SIZE) => {
    const img = kit.MakeImage(
      {
        width,
        height,
        colorType: kit.ColorType.RGBA_8888,
        alphaType: kit.AlphaType.Unpremul,
        colorSpace: kit.ColorSpace.SRGB,
      },
      data,
      width * 4
    );
    if (!img) throw new Error('test texture failed');
    return img;
  };
  const textures = [
    image(mask),
    image(cells),
    image(buildPaletteLut(palette), 256, 3),
    image(transit),
  ];
  const children = textures.map((texture, i) =>
    texture.makeShaderOptions(
      kit.TileMode.Clamp,
      kit.TileMode.Clamp,
      i === 2 ? kit.FilterMode.Linear : kit.FilterMode.Nearest,
      kit.MipmapMode.None
    )
  );
  const uniforms = packDotFieldUniforms({
    region,
    palette,
    pixelRatio: 1,
    lod: 0,
    transitEnabled,
    explorationEnabled,
    reveal,
  });
  expect(uniforms).toHaveLength(effect.getUniformFloatCount());
  const shader = effect.makeShaderWithChildren(uniforms, children);
  const surface = kit.MakeSurface(SIZE, SIZE)!;
  const paint = new kit.Paint();
  paint.setShader(shader);
  surface.getCanvas().drawPaint(paint);
  const snapshot = surface.makeImageSnapshot();
  const pixels = snapshot.readPixels(0, 0, {
    width: SIZE,
    height: SIZE,
    colorType: kit.ColorType.RGBA_8888,
    alphaType: kit.AlphaType.Unpremul,
    colorSpace: kit.ColorSpace.SRGB,
  }) as Uint8Array;
  const result = new Uint8Array(pixels);
  snapshot.delete();
  paint.delete();
  shader.delete();
  children.forEach((child) => child.delete());
  textures.forEach((texture) => texture.delete());
  surface.delete();
  return result;
}

function changedRows(a: Uint8Array, b: Uint8Array): number[] {
  const rows: number[] = [];
  for (let y = 0; y < SIZE; y++) {
    const start = y * SIZE * 4;
    if (a.slice(start, start + SIZE * 4).some((v, i) => v !== b[start + i])) rows.push(y);
  }
  return rows;
}

describe('transit dot-field rendering', () => {
  it('does not sample transit ink when the layer is disabled', () => {
    expect(render({ transitEnabled: false, ink: [255, 0, 0] })).toEqual(
      render({ transitEnabled: false, ink: [0, 255, 0] })
    );
  });

  it('renders the same broad band of dots as highway coverage, not a hairline', () => {
    const ground = render({ transitEnabled: false });
    const transitRows = changedRows(ground, render());
    const highwayRows = changedRows(ground, render({ transitEnabled: false, highway: true }));
    expect(transitRows).toEqual(highwayRows);
    expect(transitRows.length).toBeGreaterThan(5);
    expect(transitRows.length).toBeLessThan(SIZE / 2);
  });

  it('preserves distinct mode inks even where a highway crosses', () => {
    const a = render({ ink: [180, 80, 140], highway: true });
    const b = render({ ink: [80, 140, 180], highway: true });
    expect(a).not.toEqual(b);
    expect(changedRows(a, b)).toEqual(changedRows(render({ transitEnabled: false }), render()));
  });

  it('applies exploration fog, but ignores cell occupancy with exploration disabled', () => {
    expect(render({ explored: false })).not.toEqual(render({ explored: true }));
    expect(render({ explored: false, explorationEnabled: false })).toEqual(
      render({ explored: true, explorationEnabled: false })
    );
  });

  it('hides transit along with the map before the cell reveal', () => {
    const pixels = render({ reveal: 0 });
    expect(pixels.every((v) => v === 0)).toBe(true);
  });
});
