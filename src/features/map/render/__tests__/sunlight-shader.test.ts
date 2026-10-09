import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TextDecoder as NodeTextDecoder } from 'node:util';
import CanvasKitInit, {
  type CanvasKit,
  type CanvasKitInitOptions,
  type RuntimeEffect,
} from 'canvaskit-wasm';

import { latLonToWorld } from '../../core/mercator';
import { sunDirection } from '../../core/sunlight';
import { SUNLIGHT_SKSL } from '../sunlight-shader';

describe('sunlight shader on real Skia', () => {
  let kit: CanvasKit;
  let effect: RuntimeEffect;
  const equinox = sunDirection(Date.parse('2026-03-20T12:00:00Z'));

  beforeAll(async () => {
    // CanvasKit is a host-only renderer; Expo's Hermes decoder lacks UTF-16.
    const decoder = global.TextDecoder;
    global.TextDecoder = NodeTextDecoder as typeof TextDecoder;
    try {
      const options: CanvasKitInitOptions & { wasmBinary: Uint8Array } = {
        wasmBinary: readFileSync(
          join(dirname(require.resolve('canvaskit-wasm')), 'canvaskit.wasm')
        ),
      };
      kit = await CanvasKitInit(options);
    } finally {
      global.TextDecoder = decoder;
    }
    effect = kit.RuntimeEffect.Make(SUNLIGHT_SKSL)!;
    expect(effect).not.toBeNull();
  });
  afterAll(() => effect?.delete());

  function pixel(x: number, y: number, sun = equinox, opacity = 1) {
    const surface = kit.MakeSurface(1, 1)!;
    const shader = effect.makeShader([x, y, 0, ...sun, opacity]);
    const paint = new kit.Paint();
    paint.setShader(shader);
    surface.getCanvas().clear(kit.TRANSPARENT);
    surface.getCanvas().drawPaint(paint);
    surface.flush();
    const image = surface.makeImageSnapshot();
    const rgba = image.readPixels(0, 0, {
      width: 1,
      height: 1,
      colorType: kit.ColorType.RGBA_8888,
      alphaType: kit.AlphaType.Unpremul,
      colorSpace: kit.ColorSpace.SRGB,
    })!;
    const result = Array.from(rgba);
    image.delete();
    paint.delete();
    shader.delete();
    surface.dispose();
    return result;
  }

  it('adds a low-alpha warm day and cool night rather than obscuring the map', () => {
    const day = pixel(0.5, 0.5);
    const night = pixel(0, 0.5);
    expect(day[0]).toBeGreaterThan(day[2]);
    expect(night[2]).toBeGreaterThan(night[0]);
    expect(day[3]).toBeCloseTo(255 * 0.075, 0);
    expect(night[3]).toBeCloseTo(255 * 0.16, 0);
  });

  it('blends continuously across the terminator and across the dateline', () => {
    const lon = (Math.atan2(equinox[1], equinox[0]) * 180) / Math.PI + 90;
    const x = lon / 360 + 0.5;
    const twilight = pixel(x, 0.5);
    const nearby = pixel(x + 0.0001, 0.5);
    expect(twilight[3]).toBeGreaterThan(pixel(0.5, 0.5)[3]);
    expect(twilight[3]).toBeLessThan(pixel(0, 0.5)[3]);
    twilight.forEach((channel, index) => {
      expect(Math.abs(channel - nearby[index])).toBeLessThanOrEqual(1);
    });
    expect(pixel(0, 0.3)).toEqual(pixel(1, 0.3));
  });

  it('handles polar day and night without a singular terminator', () => {
    const summer = sunDirection(Date.parse('2026-06-21T12:00:00Z'));
    const north = latLonToWorld({ lat: 80, lon: 180 });
    const south = latLonToWorld({ lat: -80, lon: 0 });
    expect(pixel(...north, summer)[3]).toBe(19);
    expect(pixel(...south, summer)[3]).toBe(41);
  });

  it('leaves terrain zoom and the polar letterbox untouched', () => {
    expect(pixel(0.5, 0.5, equinox, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(0.5, -0.01)).toEqual([0, 0, 0, 0]);
    expect(pixel(0.5, 1.01)).toEqual([0, 0, 0, 0]);
    expect(pixel(-0.01, 0.5)).toEqual([0, 0, 0, 0]);
    expect(pixel(1.01, 0.5)).toEqual([0, 0, 0, 0]);
  });
});
