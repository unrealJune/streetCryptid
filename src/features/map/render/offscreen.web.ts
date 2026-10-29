import type { SkImage, SkPicture } from '@shopify/react-native-skia';

import type { ImageConsumer } from './offscreen';

export type { ImageConsumer } from './offscreen';

/**
 * Web twin of `offscreen.ts`: every offscreen render in ONE WebGL context.
 *
 * React Native Skia's web `Surface.MakeOffscreen` creates a new `OffscreenCanvas`
 * and a new WebGL context on every call and never releases them. A region build
 * makes four, so a few minutes of panning exhausted Chrome's context budget: it
 * began dropping contexts, the map canvas among them (a white canvas with the
 * crashed-GPU icon), and every build also paid a fresh context's shader
 * compilation. One shared context also lets a `same-thread` image stay a texture
 * here, exactly as on native, since its consumer renders in the same context.
 */

/* Raw CanvasKit below RN Skia's types: `any` is deliberate here. */
interface Shared {
  readonly ck: any;
  readonly gr: any;
  /** RN Skia's web image wrapper, so a result is an ordinary SkImage to the app. */
  readonly Image: new (ck: any, ref: any) => SkImage;
}

let shared: Shared | null = null;

function context(): Shared | null {
  if (shared) return shared;
  const ck = (globalThis as any).CanvasKit;
  const OC = (globalThis as any).OffscreenCanvas;
  if (!ck || !OC) return null;
  const gl = ck.GetWebGLContext(new OC(1, 1));
  const gr = gl ? ck.MakeWebGLContext(gl) : null;
  if (!gr) return null;
  // Required here, not at import: nothing Skia may load before CanvasKit has.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { JsiSkImage } = require('@shopify/react-native-skia/lib/module/skia/web/JsiSkImage');
  shared = { ck, gr, Image: JsiSkImage };
  return shared;
}

export function renderPicture(
  picture: SkPicture,
  width: number,
  height: number,
  consumer: ImageConsumer
): SkImage | null {
  try {
    const ctx = context();
    if (!ctx) return fallback(picture, width, height);
    const surface = ctx.ck.MakeRenderTarget(ctx.gr, width, height);
    if (!surface) return null;
    try {
      surface.getCanvas().drawPicture((picture as any).ref);
      surface.flush();
      const image = new ctx.Image(ctx.ck, surface.makeImageSnapshot());
      if (consumer === 'same-thread') return image;
      // The on-screen canvas is another WebGL context: hand it pixels, not a texture.
      try {
        return image.makeNonTextureImage();
      } finally {
        image.dispose();
      }
    } finally {
      surface.delete();
    }
  } finally {
    picture.dispose();
  }
}

/** No WebGL (a headless test browser): RN Skia's own path, one context per call. */
function fallback(picture: SkPicture, width: number, height: number): SkImage | null {
  const { drawAsImageFromPicture } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@shopify/react-native-skia') as typeof import('@shopify/react-native-skia');
  return drawAsImageFromPicture(picture, { width, height });
}
