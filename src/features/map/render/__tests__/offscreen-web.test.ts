import type { SkPicture } from '@shopify/react-native-skia';

const mockReadback = jest.fn();
const mockFallback = jest.fn();

jest.mock('@shopify/react-native-skia', () => ({
  drawAsImageFromPicture: (...args: unknown[]) => mockFallback(...args),
}));
jest.mock('@shopify/react-native-skia/lib/module/skia/web/JsiSkImage', () => ({
  JsiSkImage: jest.fn((_ck: unknown, texture: { delete(): void }) => ({
    makeNonTextureImage: mockReadback,
    dispose: () => texture.delete(),
  })),
}));

describe('web offscreen image ownership', () => {
  const pictureRef = {};
  const disposePicture = jest.fn();
  const picture: SkPicture & { ref: object } = {
    __typename__: 'Picture',
    ref: pictureRef,
    makeShader: jest.fn(),
    serialize: jest.fn(),
    dispose: disposePicture,
    [Symbol.dispose]: disposePicture,
  };
  const pixels = { dispose: jest.fn() };
  const texture = { delete: jest.fn() };
  const canvas = { drawPicture: jest.fn() };
  const surface = {
    getCanvas: () => canvas,
    flush: jest.fn(),
    makeImageSnapshot: () => texture,
    delete: jest.fn(),
  };
  const kit = {
    GetWebGLContext: jest.fn(() => 1),
    MakeWebGLContext: jest.fn(() => ({})),
    MakeRenderTarget: jest.fn(),
  };
  const originals = ['CanvasKit', 'OffscreenCanvas'].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
  );
  let renderPicture: typeof import('../offscreen.web').renderPicture;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadback.mockReturnValue(pixels);
    mockFallback.mockReturnValue(pixels);
    kit.MakeRenderTarget.mockReturnValue(surface);
    Object.defineProperty(globalThis, 'CanvasKit', { configurable: true, value: kit });
    Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: jest.fn() });
    jest.isolateModules(() => {
      renderPicture = jest.requireActual('../offscreen.web').renderPicture;
    });
  });

  afterEach(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    expect(picture.dispose).toHaveBeenCalledTimes(1);
  });

  it('transfers the texture to its same-thread caller and releases the picture and surface', () => {
    const image = renderPicture(picture, 100, 80, 'same-thread');
    expect(image).not.toBeNull();
    expect(canvas.drawPicture).toHaveBeenCalledWith(pictureRef);
    expect(surface.delete).toHaveBeenCalledTimes(1);
    expect(texture.delete).not.toHaveBeenCalled();
    expect(mockReadback).not.toHaveBeenCalled();
    image?.dispose();
    expect(texture.delete).toHaveBeenCalledTimes(1);
  });

  it('keeps only the CPU image for the UI caller', () => {
    expect(renderPicture(picture, 100, 80, 'ui')).toBe(pixels);
    expect(surface.delete).toHaveBeenCalledTimes(1);
    expect(texture.delete).toHaveBeenCalledTimes(1);
    expect(pixels.dispose).not.toHaveBeenCalled();
  });

  it('releases the picture when target allocation fails', () => {
    kit.MakeRenderTarget.mockReturnValueOnce(null);
    expect(renderPicture(picture, 100, 80, 'same-thread')).toBeNull();
    expect(surface.delete).not.toHaveBeenCalled();
  });

  it('releases the surface and picture when drawing throws', () => {
    canvas.drawPicture.mockImplementationOnce(() => {
      throw new Error('draw failed');
    });
    expect(() => renderPicture(picture, 100, 80, 'same-thread')).toThrow('draw failed');
    expect(surface.delete).toHaveBeenCalledTimes(1);
  });

  it('releases the texture, surface and picture when readback throws', () => {
    mockReadback.mockImplementationOnce(() => {
      throw new Error('readback failed');
    });
    expect(() => renderPicture(picture, 100, 80, 'ui')).toThrow('readback failed');
    expect(surface.delete).toHaveBeenCalledTimes(1);
    expect(texture.delete).toHaveBeenCalledTimes(1);
  });

  it('consumes the picture on the no-WebGL fallback too', () => {
    Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined });
    expect(renderPicture(picture, 100, 80, 'ui')).toBe(pixels);
    expect(mockFallback).toHaveBeenCalledWith(picture, { width: 100, height: 80 });
    expect(kit.MakeRenderTarget).not.toHaveBeenCalled();
    expect(pixels.dispose).not.toHaveBeenCalled();
  });

  it('releases the picture if the fallback throws', () => {
    Object.defineProperty(globalThis, 'OffscreenCanvas', { value: undefined });
    mockFallback.mockImplementationOnce(() => {
      throw new Error('fallback failed');
    });
    expect(() => renderPicture(picture, 100, 80, 'ui')).toThrow('fallback failed');
  });
});
