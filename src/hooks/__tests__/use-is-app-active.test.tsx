import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, Text } from 'react-native';

import { useIsAppActive } from '../use-is-app-active';

/**
 * The gate every repainting loop hangs off, so its edge cases are the app's edge cases.
 *
 * The one that matters is `'inactive'`. iOS reports it during a cold launch, while a permission
 * alert is up, and in the app switcher — so treating it as "off screen" would cancel animations
 * mid-launch and on every permission prompt. `native-runtime-owner.ts` records the same lesson
 * about trusting `AppState.currentState` as a guard at all: the only state that reliably means
 * off screen is `'background'`.
 */

/** Replace `addEventListener` so a state transition can actually be delivered. */
function appStateHarness() {
  const listeners: ((state: string) => void)[] = [];
  const original = AppState.addEventListener;
  (AppState as unknown as { addEventListener: unknown }).addEventListener = (
    _event: string,
    listener: (state: string) => void
  ) => {
    listeners.push(listener);
    return {
      remove: () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      },
    };
  };
  return {
    listenerCount: () => listeners.length,
    go(state: string) {
      (AppState as unknown as { currentState: string }).currentState = state;
      act(() => {
        for (const listener of [...listeners]) listener(state);
      });
    },
    restore: () => {
      (AppState as unknown as { addEventListener: unknown }).addEventListener = original;
    },
  };
}

function Probe() {
  return <Text>{useIsAppActive() ? 'active' : 'idle'}</Text>;
}

describe('useIsAppActive', () => {
  let harness: ReturnType<typeof appStateHarness>;
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    harness = appStateHarness();
    (AppState as unknown as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    harness.restore();
  });

  function mount(): void {
    act(() => {
      renderer = create(<Probe />);
    });
  }

  function reading(): string {
    return renderer!.root.findByType(Text).props.children as string;
  }

  it('reports active while the app is on screen', () => {
    mount();
    expect(reading()).toBe('active');
  });

  it('goes idle on background and comes back on foreground', () => {
    mount();
    harness.go('background');
    expect(reading()).toBe('idle');
    harness.go('active');
    expect(reading()).toBe('active');
  });

  it('does not treat inactive as off screen', () => {
    mount();
    harness.go('inactive');
    expect(reading()).toBe('active');
  });

  /** A launch that begins in the background must read as off screen from the first render. */
  it('reads the state it was mounted in, without waiting for a transition', () => {
    (AppState as unknown as { currentState: string }).currentState = 'background';
    mount();
    expect(reading()).toBe('idle');
  });

  it('unsubscribes on unmount', () => {
    mount();
    expect(harness.listenerCount()).toBe(1);
    act(() => renderer?.unmount());
    renderer = undefined;
    expect(harness.listenerCount()).toBe(0);
  });
});
