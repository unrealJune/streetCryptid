import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';

import { elevationRgba, type ElevationRaster } from '../../core/terrain';
import { buildTerrainImage } from '../terrain-image';

jest.mock('@shopify/react-native-skia', () => ({
  AlphaType: { Opaque: 1 },
  ColorType: { RGBA_8888: 4 },
  Skia: {
    Data: {
      fromBytes: jest.fn((bytes: Uint8Array) => ({ bytes, dispose: jest.fn() })),
    },
    Image: { MakeImage: jest.fn(() => ({ dispose: jest.fn() })) },
  },
}));

jest.mock('../../core/terrain', () => {
  const actual = jest.requireActual('../../core/terrain');
  return { ...actual, elevationRgba: jest.fn(actual.elevationRgba) };
});

const raster = (): ElevationRaster => ({
  width: 2,
  height: 2,
  metres: new Float32Array([500, 600, 700, 800]),
  rect: { minX: 0.3, minY: 0.3, maxX: 0.31, maxY: 0.31 },
});

describe('region-owned DEM images', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    for (const result of jest.mocked(Skia.Data.fromBytes).mock.results) {
      if (result.type === 'return') expect(result.value.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('reuses the encoding but never an image disposed by a preceding region', () => {
    const elevation = raster();
    const first = buildTerrainImage(elevation);
    first.image?.dispose();
    const next = buildTerrainImage(elevation);

    expect(first.hasElevation).toBe(true);
    expect(next.hasElevation).toBe(true);
    expect(next.image).not.toBe(first.image);
    expect(next.image?.dispose).not.toHaveBeenCalled();
    expect(elevationRgba).toHaveBeenCalledTimes(1);
    const calls = jest.mocked(Skia.Data.fromBytes).mock.calls;
    expect(calls[1][0]).toBe(calls[0][0]);
    expect(Skia.Image.MakeImage).toHaveBeenLastCalledWith(
      { width: 2, height: 2, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Opaque },
      expect.anything(),
      8
    );
  });

  it('does not reuse pixels when the raster identity changes', () => {
    buildTerrainImage(raster());
    buildTerrainImage(raster());
    expect(elevationRgba).toHaveBeenCalledTimes(2);
    const calls = jest.mocked(Skia.Data.fromBytes).mock.calls;
    expect(calls[1][0]).not.toBe(calls[0][0]);
  });

  it('reports allocation failure and retries with the cached pixels, not a dead image', () => {
    const elevation = raster();
    jest.mocked(Skia.Image.MakeImage).mockReturnValueOnce(null);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(buildTerrainImage(elevation)).toEqual({ image: null, hasElevation: false });
      expect(warning).toHaveBeenCalledWith('[map] DEM image allocation failed (2x2)');
      expect(buildTerrainImage(elevation).hasElevation).toBe(true);
      expect(elevationRgba).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });

  it('releases the pixel-data wrapper when image creation throws', () => {
    jest.mocked(Skia.Image.MakeImage).mockImplementationOnce(() => {
      throw new Error('image failed');
    });
    expect(() => buildTerrainImage(raster())).toThrow('image failed');
  });
});
