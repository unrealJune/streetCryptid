import { Skia } from '@shopify/react-native-skia';

import { getDotFieldEffect, getDotMaterialEffect } from '../dot-field-shader';
import { dotFieldSksl, DOT_MATERIAL_SKSL, DOT_POINT_MATERIAL_SKSL } from '../dot-field-sksl';

jest.mock('@shopify/react-native-skia', () => ({
  Skia: { RuntimeEffect: { Make: jest.fn((source: string) => ({ source })) } },
}));

it('compiles each field/material variant once, including failed compilations', () => {
  const make = jest.mocked(Skia.RuntimeEffect.Make);
  make.mockReturnValueOnce(null);
  for (const filteredAreas of [false, true])
    for (const blendLevels of [false, true]) {
      const mode = { filteredAreas, blendLevels };
      const effect = getDotFieldEffect(mode);
      expect(getDotFieldEffect(mode)).toBe(effect);
      expect(make).toHaveBeenLastCalledWith(dotFieldSksl(mode));
      if (!filteredAreas && !blendLevels) expect(effect).toBeNull();
      else expect(effect).not.toBeNull();
    }
  expect(make).toHaveBeenCalledTimes(4);

  make.mockReturnValueOnce(null);
  for (const filteredAreas of [false, true]) {
    const effect = getDotMaterialEffect(filteredAreas);
    expect(getDotMaterialEffect(filteredAreas)).toBe(effect);
    expect(make).toHaveBeenLastCalledWith(
      filteredAreas ? DOT_MATERIAL_SKSL : DOT_POINT_MATERIAL_SKSL
    );
    if (filteredAreas) expect(effect).not.toBeNull();
    else expect(effect).toBeNull();
  }
  expect(make).toHaveBeenCalledTimes(6);
  expect(new Set(make.mock.calls.map(([source]) => source)).size).toBe(6);
});
