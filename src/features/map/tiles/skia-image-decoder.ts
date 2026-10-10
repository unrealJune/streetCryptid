import type { DecodedImage, ImageDecoder } from './elevation-source';

/**
 * Decode a WebP/PNG tile to unpremultiplied RGBA with Skia — the decoder the
 * elevation source uses on device and on web.
 *
 * Skia is required lazily, at the first decode, never at import: on web the
 * Skia module captures CanvasKit when it is first evaluated, and this file is
 * reachable from `config.ts`, which loads before `WithSkiaWeb` has fetched the
 * wasm (see `map-screen.web.tsx`).
 */
export const skiaImageDecoder: ImageDecoder = (bytes) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const skia = require('@shopify/react-native-skia') as typeof import('@shopify/react-native-skia');
  const { AlphaType, ColorType, Skia } = skia;
  const data = Skia.Data.fromBytes(bytes);
  const image = Skia.Image.MakeImageFromEncoded(data);
  data.dispose();
  if (!image) return null;
  const width = image.width();
  const height = image.height();
  const pixels = image.readPixels(0, 0, {
    width,
    height,
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  image.dispose();
  if (!(pixels instanceof Uint8Array)) return null;
  const decoded: DecodedImage = { width, height, rgba: pixels };
  return decoded;
};
