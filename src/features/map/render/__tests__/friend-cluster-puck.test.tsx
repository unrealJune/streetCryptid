import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import { FriendClusterPuck } from '../friend-cluster-puck';

jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (factory: () => object) => factory(),
  };
});

const shared = { value: 1 } as SharedValue<number>;
const zero = { value: 0 } as SharedValue<number>;

const member = (id: string, color = '#45d6bd') => ({ id, color });

function renderPuck(
  members: readonly { id: string; color: string; self?: boolean }[],
  onPress = jest.fn()
) {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FriendClusterPuck
        inkColor="#152633"
        members={members}
        onPress={onPress}
        panelColor="rgba(255,255,255,.9)"
        scale={shared}
        translateX={zero}
        translateY={zero}
        x={120}
        y={240}
      />
    );
  });
  return { renderer, onPress };
}

describe('FriendClusterPuck', () => {
  let active: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => active?.unmount());
    active = undefined;
  });

  it('shows the friend count and announces the group', () => {
    const { renderer } = renderPuck([member('a'), member('b'), member('c'), member('d')]);
    active = renderer;

    const text = renderer.root.findAllByType(Text);
    expect(text[0].props.children).toBe(4);

    const button = renderer.root.findByProps({ accessibilityRole: 'button' });
    expect(button.props.accessibilityLabel).toBe('4 friends in this area');
  });

  it('counts friends, not you, and says so', () => {
    const { renderer } = renderPuck([
      member('a'),
      member('b'),
      { id: 'self', color: '#f0a500', self: true },
    ]);
    active = renderer;

    // You are in the group but you are not one of "the friends here".
    expect(renderer.root.findAllByType(Text)[0].props.children).toBe(2);
    expect(
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.accessibilityLabel
    ).toBe('2 friends and you in this area');
  });

  it('asks the map to separate the group when tapped', () => {
    const { renderer, onPress } = renderPuck([member('a'), member('b'), member('c')]);
    active = renderer;

    act(() => renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('caps the ring at a readable number of segments', () => {
    const many = Array.from({ length: 12 }, (_, i) => member(`f${i}`, `#0000${i % 10}0`));
    const { renderer } = renderPuck(many);
    active = renderer;

    const segments = renderer.root.findAllByType(View).filter((node) => {
      const style = node.props.style;
      return Array.isArray(style) && style.some((s: unknown) => isSegmentStyle(s));
    });
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.length).toBeLessThanOrEqual(6);
    // The count itself still reports everyone, not just the drawn segments.
    expect(renderer.root.findAllByType(Text)[0].props.children).toBe(12);
  });
});

function isSegmentStyle(style: unknown): boolean {
  return Boolean(style) && typeof style === 'object' && 'borderTopColor' in (style as object);
}
