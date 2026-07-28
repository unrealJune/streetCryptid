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

  it('opens settings from the map', () => {
    const onPress = render();

    const button = renderer.root.findByProps({ accessibilityLabel: 'Settings' });
    act(() => button.props.onPress());

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('stays neutral steel — settings is chrome, not a signal', () => {
    render();
    const { chrome } = CryptidThemes.daybreak;

    const button = renderer.root.findByProps({ accessibilityLabel: 'Settings' });
    const style = button.props.style({ pressed: false });
    expect(style).toContainEqual(
      expect.objectContaining({ backgroundColor: chrome.island, borderColor: chrome.islandBorder })
    );
    // Never amber (YOU / frontier) and never green (friends).
    expect(JSON.stringify(style)).not.toContain(chrome.amber);
    expect(JSON.stringify(style)).not.toContain(chrome.green);
  });
});
