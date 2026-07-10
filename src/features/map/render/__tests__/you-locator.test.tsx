import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import { YouLocator } from '../you-locator';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    cancelAnimation: jest.fn(),
    Easing: { out: (value: unknown) => value, quad: 'quad' },
    useAnimatedStyle: (factory: () => object) => factory(),
    useReducedMotion: () => true,
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});

describe('YouLocator', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('opens your location history and exposes its selected state', () => {
    const onPress = jest.fn();
    const scale = { value: 1 } as SharedValue<number>;
    const translateX = { value: 0 } as SharedValue<number>;
    const translateY = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <YouLocator
          accent={[255, 184, 77]}
          onPress={onPress}
          panelColor="#00111f"
          scale={scale}
          selected
          translateX={translateX}
          translateY={translateY}
          x={100}
          y={200}
        />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Open your location history' });
    expect(button.props.accessibilityLabel).toBe('Open your location history');
    expect(button.props.accessibilityState).toEqual({ selected: true });

    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes the default unselected state', () => {
    const sharedValue = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <YouLocator
          accent={[255, 184, 77]}
          onPress={jest.fn()}
          panelColor="#00111f"
          scale={sharedValue}
          translateX={sharedValue}
          translateY={sharedValue}
          x={0}
          y={0}
        />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Open your location history' });
    expect(button.props.accessibilityState).toEqual({ selected: false });
  });
});
