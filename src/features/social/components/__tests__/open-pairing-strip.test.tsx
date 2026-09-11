import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { OpenPairingStrip } from '../open-pairing-strip';

jest.mock('@/global.css', () => ({}));

describe('OpenPairingStrip', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('opens the unified pairing screen without exposing a separate arm action', () => {
    const onOpen = jest.fn();
    act(() => {
      renderer = create(<OpenPairingStrip onOpen={onOpen} theme={CryptidThemes.daybreak} />);
    });

    const button = renderer.root.findByProps({ accessibilityLabel: 'Open pairing' });
    act(() => button.props.onPress());

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Arm bump' })).toHaveLength(0);
  });
});
