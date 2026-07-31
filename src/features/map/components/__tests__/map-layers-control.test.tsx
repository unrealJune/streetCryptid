import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { MapLayersControl } from '../map-layers-control';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

const layers = { exploration: true, highways: true };

describe('MapLayersControl', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  const expand = (onChange: (layer: 'exploration' | 'highways', enabled: boolean) => void) => {
    act(() => {
      renderer = create(
        <MapLayersControl layers={layers} onChange={onChange} theme={CryptidThemes.daybreak} />
      );
    });
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Map layers' }).props.onPress());
  };

  it('keeps the panel collapsed until the layers button is pressed', () => {
    act(() => {
      renderer = create(
        <MapLayersControl layers={layers} onChange={jest.fn()} theme={CryptidThemes.daybreak} />
      );
    });

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Highways layer' })).toHaveLength(0);
  });

  it('toggles the highways layer off', () => {
    const onChange = jest.fn();
    expand(onChange);

    const row = renderer.root.findByProps({ accessibilityLabel: 'Highways layer' });
    expect(row.props.accessibilityState).toEqual({ checked: true });

    act(() => row.props.onPress());
    expect(onChange).toHaveBeenCalledWith('highways', false);
  });

  it('toggles the exploration layer off', () => {
    const onChange = jest.fn();
    expand(onChange);

    act(() =>
      renderer.root.findByProps({ accessibilityLabel: 'Exploration layer' }).props.onPress()
    );
    expect(onChange).toHaveBeenCalledWith('exploration', false);
  });
});
