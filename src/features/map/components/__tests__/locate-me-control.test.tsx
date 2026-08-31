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

  it('invokes the locate action', () => {
    const onPress = jest.fn();
    act(() => {
      renderer = create(
        <LocateMeControl busy={false} onPress={onPress} theme={CryptidThemes.daybreak} />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Locate me' });
    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is pressable with no position yet, because the press is what goes and gets one', () => {
    // Regression, 2026-08-30: this was disabled until `hasLiveSelfFix`, which is only set by
    // something reaching the PUBLISH path — so a freshly installed, correctly paired app presented
    // a dead button while perfectly able to answer "where am I" in a few hundred milliseconds.
    // "Where am I" and "have I told anyone where I am" are different questions.
    const onPress = jest.fn();
    act(() => {
      renderer = create(
        <LocateMeControl busy={false} onPress={onPress} theme={CryptidThemes.daybreak} />
      );
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Locate me' });
    expect(button.props.disabled).toBe(false);
    act(() => button.props.onPress());
    expect(onPress).toHaveBeenCalled();
  });

  it('does not re-fire while a read is already in flight', () => {
    const onPress = jest.fn();
    act(() => {
      renderer = create(<LocateMeControl busy onPress={onPress} theme={CryptidThemes.daybreak} />);
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Locate me' });
    expect(button.props.disabled).toBe(true);
    // `busy`, not `disabled`: the control is working, not unavailable, and a screen reader should
    // say so.
    expect(button.props.accessibilityState).toEqual({ busy: true });
  });
});
