import { Skia } from '@shopify/react-native-skia';

import { getDotFieldEffect, getDotMaterialEffect } from '../dot-field-shader';
import { DOT_FIELD_SKSL, DOT_MATERIAL_SKSL } from '../dot-field-sksl';

jest.mock('@shopify/react-native-skia', () => ({
  Skia: { RuntimeEffect: { Make: jest.fn((source: string) => ({ source })) } },
}));

it('compiles only one field and one material effect, caching failures too', () => {
  const make = jest.mocked(Skia.RuntimeEffect.Make);
  make.mockReturnValueOnce(null);
  expect(getDotFieldEffect()).toBeNull();
  expect(getDotFieldEffect()).toBeNull();
  expect(make).toHaveBeenCalledTimes(1);
  expect(make).toHaveBeenLastCalledWith(DOT_FIELD_SKSL);

  const material = getDotMaterialEffect();
  expect(material).not.toBeNull();
  expect(getDotMaterialEffect()).toBe(material);
  expect(make).toHaveBeenCalledTimes(2);
  expect(make).toHaveBeenLastCalledWith(DOT_MATERIAL_SKSL);
});
