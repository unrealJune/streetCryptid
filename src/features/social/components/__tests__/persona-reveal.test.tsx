import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { Friend } from '../../core/types';
import { PersonaReveal } from '../persona-reveal';

jest.mock('@/global.css', () => ({}));
jest.mock('react-native-reanimated', () => {
  const { View, Text: RNText } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: {
      View,
      Text: RNText,
      createAnimatedComponent: (component: unknown) => component,
    },
    FadeIn: { duration: () => undefined },
    LinearTransition: { duration: () => undefined },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    useReducedMotion: () => false,
    withTiming: (value: number) => value,
  };
});

const PLACEHOLDER_HANDLE = '@a1b2c3d4';

function friend(overrides: Partial<Friend> = {}): Friend {
  return {
    endpointId: 'a1b2c3d4e5f6',
    handle: PLACEHOLDER_HANDLE,
    sigil: 'unknown',
    recvPublic: 'recv',
    ticket: 'ticket',
    pairedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Every string the tree renders, joined. Walks the JSON so it does not care which Text wrapper
 * produced it — `ThemedText`, a plain `Text`, or the mocked `Animated.Text`. */
function textOf(renderer: ReactTestRenderer): string {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return found.join(' ');
}

describe('PersonaReveal', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  it('draws the endpoint id as ciphertext while the profile is still replicating', () => {
    jest.useFakeTimers();
    act(() => {
      renderer = create(<PersonaReveal accent="#2f9e6a" friend={friend()} neutral="#8a9aa6" />);
    });
    act(() => {
      jest.advanceTimersByTime(200);
    });

    const rendered = textOf(renderer);
    expect(rendered).toContain('DECRYPTING PERSONA');
    // The placeholder is the ciphertext, so it must not be sitting there legibly underneath it.
    expect(rendered).not.toContain(PLACEHOLDER_HANDLE);
  });

  it('settles into the real handle once the profile lands', () => {
    jest.useFakeTimers();
    const placeholder = friend();
    act(() => {
      renderer = create(<PersonaReveal accent="#2f9e6a" friend={placeholder} neutral="#8a9aa6" />);
    });

    act(() => {
      renderer.update(
        <PersonaReveal
          accent="#2f9e6a"
          friend={{
            ...placeholder,
            handle: '@mothwing',
            cryptidName: 'Mothwing',
            profileEpoch: 1_700_000_000_001,
          }}
          neutral="#8a9aa6"
        />
      );
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });

    const rendered = textOf(renderer);
    expect(rendered).toContain('@mothwing');
    expect(rendered).toContain('MOTHWING');
    expect(rendered).not.toContain('DECRYPTING');
  });

  // Giving up on the ANIMATION, not on the profile. A scramble still going after this long has
  // stopped reading as "working" and started reading as broken.
  it('stops churning and says so when no profile ever arrives', () => {
    jest.useFakeTimers();
    act(() => {
      renderer = create(<PersonaReveal accent="#2f9e6a" friend={friend()} neutral="#8a9aa6" />);
    });
    act(() => {
      jest.advanceTimersByTime(20_000);
    });

    const rendered = textOf(renderer);
    expect(rendered).toContain('PERSONA UNAVAILABLE');
    expect(rendered).toContain(PLACEHOLDER_HANDLE);
  });

  // A profile that arrived with the pair result was never ciphertext to the user, so animating a
  // decrypt over it — and firing the resolve haptic — would be pure theatre.
  it('does not perform a decrypt for a persona that was never encrypted', () => {
    const onResolved = jest.fn();
    act(() => {
      renderer = create(
        <PersonaReveal
          accent="#2f9e6a"
          friend={friend({
            handle: '@mothwing',
            cryptidName: 'Mothwing',
            profileEpoch: 1_700_000_000_001,
          })}
          neutral="#8a9aa6"
          onResolved={onResolved}
        />
      );
    });

    expect(textOf(renderer)).toContain('@mothwing');
    expect(onResolved).not.toHaveBeenCalled();
  });
});
