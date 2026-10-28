import type { SkPicture } from '@shopify/react-native-skia';

import { renderPicture } from '../offscreen';

jest.mock('@shopify/react-native-skia', () => ({
  Skia: { Surface: { MakeOffscreen: jest.fn() } },
}));

describe('offscreen image ownership', () => {
  const picture = {} as SkPicture;
  const cpuImage = { dispose: jest.fn() };
  const texture = {
    makeNonTextureImage: jest.fn(() => cpuImage),
    dispose: jest.fn(),
  };
  const canvas = { drawPicture: jest.fn() };
  const surface = {
    getCanvas: () => canvas,
    flush: jest.fn(),
    makeImageSnapshot: jest.fn(() => texture),
    dispose: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .requireMock('@shopify/react-native-skia')
      .Skia.Surface.MakeOffscreen.mockReturnValue(surface);
  });

  it('releases a surface but keeps the texture returned to its same-thread consumer', () => {
    expect(renderPicture(picture, 100, 80, 'same-thread')).toBe(texture);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(texture.dispose).not.toHaveBeenCalled();
    expect(texture.makeNonTextureImage).not.toHaveBeenCalled();
  });

  it('keeps only the CPU image when the UI thread is the consumer', () => {
    expect(renderPicture(picture, 100, 80, 'ui')).toBe(cpuImage);
    expect(texture.makeNonTextureImage).toHaveBeenCalledTimes(1);
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(texture.dispose).toHaveBeenCalledTimes(1);
    expect(cpuImage.dispose).not.toHaveBeenCalled();
  });

  it('releases the surface when drawing throws', () => {
    canvas.drawPicture.mockImplementationOnce(() => {
      throw new Error('draw failed');
    });
    expect(() => renderPicture(picture, 100, 80, 'same-thread')).toThrow('draw failed');
    expect(surface.dispose).toHaveBeenCalledTimes(1);
  });

  it('releases both temporary resources when the UI readback throws', () => {
    texture.makeNonTextureImage.mockImplementationOnce(() => {
      throw new Error('readback failed');
    });
    expect(() => renderPicture(picture, 100, 80, 'ui')).toThrow('readback failed');
    expect(surface.dispose).toHaveBeenCalledTimes(1);
    expect(texture.dispose).toHaveBeenCalledTimes(1);
  });
});
