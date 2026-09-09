import { StyleSheet, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import { CryptidThemes } from '@/constants/cryptid-theme';
import { scaleFor, worldToScreen } from '../../core/camera';
import {
  cryptidMetrics,
  oceanCryptidOpacity,
  PLACED_OCEAN_CRYPTIDS,
} from '../../core/ocean-cryptids';
import { OceanCryptidLayer } from '../ocean-cryptid-layer';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (value: number) => ({ value }),
    useDerivedValue: (factory: () => object) => ({ value: factory() }),
    cancelAnimation: jest.fn(),
    Easing: { inOut: jest.fn(), sin: jest.fn() },
    withRepeat: jest.fn(),
    withTiming: jest.fn(),
  };
});

describe('OceanCryptidLayer', () => {
  const cryptid = PLACED_OCEAN_CRYPTIDS[0];
  const anchor = { center: cryptid.world, zoom: 15 };
  const viewport = { width: 390, height: 780 };
  const metrics = cryptidMetrics(cryptid.art, cryptid.waves);
  let renderer: ReactTestRenderer;

  afterEach(() => act(() => renderer?.unmount()));

  function draw(zoom: number) {
    const k = Math.pow(2, zoom - anchor.zoom);
    const shared = (value: number) => ({ value }) as SharedValue<number>;
    act(() => {
      renderer = create(
        <OceanCryptidLayer
          anchor={anchor}
          cryptids={[cryptid]}
          palette={CryptidThemes.daybreak.canvas}
          reducedMotion
          scale={shared(k)}
          translateX={shared((viewport.width / 2) * (1 - k))}
          translateY={shared((viewport.height / 2) * (1 - k))}
          viewport={viewport}
        />
      );
    });
    const figure = renderer.root
      .findAllByType(View)
      .find((node) => node.props.pointerEvents === 'none')!;
    return StyleSheet.flatten(figure.props.style);
  }

  it.each([1, 2, 3, 4, 5, 6])(
    'keeps the center pinned to its ocean coordinate at zoom %s',
    (zoom) => {
      const style = draw(zoom);
      const position = worldToScreen({ ...anchor, zoom }, viewport, cryptid.world);
      expect(style.transform[0].translateX + metrics.width / 2).toBeCloseTo(position[0], 8);
      expect(style.transform[1].translateY + metrics.height / 2).toBeCloseTo(position[1], 8);
      expect(style.opacity).toBeCloseTo(oceanCryptidOpacity(zoom), 8);
      // Screen size changes, but the footprint's world size never does.
      expect((metrics.width * style.transform[2].scale) / scaleFor(zoom)).toBeCloseTo(
        metrics.width / scaleFor(4),
        10
      );
    }
  );

  it('hides immediately at street zoom without waiting for a tile-camera commit', () => {
    expect(draw(15).opacity).toBe(0);
  });
});
