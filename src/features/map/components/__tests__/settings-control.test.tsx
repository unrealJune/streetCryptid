import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { SettingsControl } from '../settings-control';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

describe('SettingsControl', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(onPress = jest.fn()) {
    act(() => {
      renderer = create(<SettingsControl onPress={onPress} theme={CryptidThemes.daybreak} />);
    });
    return onPress;
  }

  /**
   * The `Pressable` inside `IslandPressable`, not the host view under it — the label is on all
   * three, and the Pressable is the one carrying `onPress` and the style function.
   */
  function button() {
    return renderer.root
      .findAllByProps({ accessibilityLabel: 'Settings' })
      .find((node) => typeof node.props.style === 'function')!;
  }

  it('opens settings from the map', () => {
    const onPress = render();

    act(() => button().props.onPress());

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('stays neutral steel — settings is chrome, not a signal', () => {
    render();
    const { chrome } = CryptidThemes.daybreak;

    const style = button().props.style({ pressed: false }) as object[];
    // The opaque island surface — what Android, web and every iPhone before iOS 26 draw. Liquid
    // glass is off in tests by default (see `jest.setup.js`); `glass-surface.test.tsx` is where
    // the other path is covered.
    expect(style).toContainEqual(expect.objectContaining({ backgroundColor: chrome.island }));
    expect(style).toContainEqual(expect.objectContaining({ borderColor: chrome.islandBorder }));
    // Never amber (YOU / frontier) and never green (friends).
    expect(JSON.stringify(style)).not.toContain(chrome.amber);
    expect(JSON.stringify(style)).not.toContain(chrome.green);
  });
});
