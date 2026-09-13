import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SharedValue } from 'react-native-reanimated';

import { FriendLocatorStack } from '../friend-locator-stack';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (factory: () => object) => factory(),
  };
});

describe('FriendLocatorStack', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('renders and selects every friend in an overlapping stack', () => {
    const onPress = jest.fn();
    const sharedValue = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <FriendLocatorStack
          friends={[
            {
              id: 'moth',
              handle: '@moth',
              sigil: '/\\',
              color: '#45d6bd',
              selected: false,
            },
            {
              id: 'frog',
              handle: '@frog',
              sigil: '(o)',
              color: '#f7b84b',
              selected: true,
            },
          ]}
          onPress={onPress}
          panelColor="#00111f"
          scale={sharedValue}
          translateX={sharedValue}
          translateY={sharedValue}
          x={100}
          y={200}
        />
      );
    });

    const moth = renderer.root.findByProps({
      accessibilityLabel: "Open @moth's location history",
    });
    const frog = renderer.root.findByProps({
      accessibilityLabel: "Open @frog's location history",
    });
    expect(moth.props.accessibilityState).toEqual({ selected: false });
    expect(frog.props.accessibilityState).toEqual({ selected: true });

    act(() => moth.props.onPress());
    act(() => frog.props.onPress());
    expect(onPress).toHaveBeenNthCalledWith(1, 'moth');
    expect(onPress).toHaveBeenNthCalledWith(2, 'frog');
  });

  it('lays the cryptid cards out side by side on one baseline', () => {
    const sharedValue = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <FriendLocatorStack
          friends={[
            {
              id: 'moth',
              handle: '@moth',
              sigil: `(**)
(__)`,
              color: '#45d6bd',
              selected: false,
            },
            { id: 'frog', handle: '@frog', sigil: '(o)', color: '#f7b84b', selected: false },
          ]}
          onPress={jest.fn()}
          panelColor="#00111f"
          scale={sharedValue}
          translateX={sharedValue}
          translateY={sharedValue}
          x={100}
          y={200}
        />
      );
    });

    const cards = renderer.root
      .findAllByProps({ accessibilityElementsHidden: true })
      // Host views only: `findAllByProps` reports the composite element too.
      .filter((node) => typeof node.type === 'string')
      .map((node) => node.props.style?.[1])
      .filter((style): style is Record<string, number> => typeof style?.left === 'number');
    expect(cards).toHaveLength(2);

    // No card starts before the previous one ends: the row is a row, not a pile.
    const [first, second] = cards;
    expect(second.left).toBeGreaterThanOrEqual(first.left + first.width);
    // Different art, different heights — but both cards end on the same line.
    expect(first.top + first.height).toBe(second.top + second.height);
  });

  it('includes YOU as an independently selectable row in an overlapping stack', () => {
    const onPress = jest.fn();
    const onPressSelf = jest.fn();
    const sharedValue = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <FriendLocatorStack
          friends={[
            {
              id: 'moth',
              handle: '@moth',
              sigil: '/\\',
              color: '#45d6bd',
              selected: false,
            },
            {
              id: 'self',
              handle: 'YOU',
              sigil: '',
              color: '#f7b84b',
              selected: true,
              self: true,
            },
          ]}
          onPress={onPress}
          onPressSelf={onPressSelf}
          panelColor="#00111f"
          scale={sharedValue}
          translateX={sharedValue}
          translateY={sharedValue}
          x={100}
          y={200}
        />
      );
    });

    expect(
      renderer.root.findByProps({ accessibilityLabel: '1 friend and you in this area' })
    ).toBeDefined();
    const you = renderer.root.findByProps({ accessibilityLabel: 'Open your location history' });
    expect(you.props.accessibilityState).toEqual({ selected: true });

    act(() => you.props.onPress());
    expect(onPressSelf).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('labels a self-only stack without referring to zero friends', () => {
    const sharedValue = { value: 0 } as SharedValue<number>;

    act(() => {
      renderer = create(
        <FriendLocatorStack
          friends={[
            {
              id: 'self',
              handle: 'YOU',
              sigil: '',
              color: '#f7b84b',
              selected: false,
              self: true,
            },
          ]}
          onPress={jest.fn()}
          onPressSelf={jest.fn()}
          panelColor="#00111f"
          scale={sharedValue}
          translateX={sharedValue}
          translateY={sharedValue}
          x={100}
          y={200}
        />
      );
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'You are in this area' })).toBeDefined();
  });
});
