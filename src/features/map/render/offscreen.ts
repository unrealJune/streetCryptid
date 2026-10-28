import { Skia, type SkImage, type SkPicture } from '@shopify/react-native-skia';

/**
 * Who will draw a rendered image.
 *
 * - `same-thread`: only the JS thread, as an input to another offscreen render
 *   (the feature mask, ground and terrain textures the dot field samples). The
 *   image stays a GPU texture.
 * - `ui`: the on-screen canvas. Skia's GPU contexts are per thread, so the image
 *   has to be copied back to CPU memory (`makeNonTextureImage`) for the UI
 *   thread to upload it again.
 *
 * `drawAsImageFromPicture` always does the `ui` copy. That copy is a GPU→CPU
 * readback, so it also waits for the GPU to finish everything queued before it:
 * paying it for the three intermediate textures of every region build stalled
 * the JS thread three extra times per build, and then re-uploaded what it had
 * just read back.
 */
export type ImageConsumer = 'same-thread' | 'ui';

/**
 * Rasterize `picture` into a `width × height` GPU image for `consumer`.
 *
 * Takes ownership of `picture` and disposes it, along with the surface and — for
 * a `ui` copy — the GPU snapshot it was read back from. These are JSI host
 * objects: Hermes sees a few bytes each and has no idea a full-screen bitmap
 * hangs off them, so leaving them to the GC means it effectively never comes.
 * On 2026-10-22 an emulator panning the map grew its native heap ~80 MB every
 * 30 s through `makeNonTextureImage` alone, and a Pixel 10 was killed by the
 * low-memory killer at 3.5 GB. Disposing a wrapper only drops its reference;
 * Skia frees the pixels once nothing (a picture, a shader) still holds them.
 */
export function renderPicture(
  picture: SkPicture,
  width: number,
  height: number,
  consumer: ImageConsumer
): SkImage | null {
  try {
    const surface = Skia.Surface.MakeOffscreen(width, height);
    if (!surface) return null;
    try {
      surface.getCanvas().drawPicture(picture);
      surface.flush();
      const image = surface.makeImageSnapshot();
      if (consumer === 'same-thread') return image;
      try {
        return image.makeNonTextureImage();
      } finally {
        image.dispose();
      }
    } finally {
      surface.dispose();
    }
  } finally {
    picture.dispose();
  }
}
