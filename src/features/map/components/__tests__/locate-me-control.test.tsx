import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { LocateMeControl } from '../locate-me-control';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

describe('LocateMeControl', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('invokes the locate action when a location is available', () => {
    const onPress = jest.fn();
    act(() => {
      renderer = create(
        <LocateMeControl disabled={false} onPress={onPress} theme={CryptidThemes.daybreak} />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Locate me' });
    expect(button.props.accessibilityState).toEqual({ disabled: false });

    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is disabled when no location is available', () => {
    act(() => {
      renderer = create(
        <LocateMeControl disabled onPress={jest.fn()} theme={CryptidThemes.daybreak} />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Locate me' });
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });
});
