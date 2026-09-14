import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { MapLayersControl, type MapLayerId } from '../map-layers-control';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

const layers = { exploration: true, highways: true, transit: false, structures: true };

describe('MapLayersControl', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  const expand = (onChange: (layer: MapLayerId, enabled: boolean) => void) => {
    act(() => {
      renderer = create(
        <MapLayersControl
          expanded
          layers={layers}
          onChange={onChange}
          onExpandedChange={jest.fn()}
          theme={CryptidThemes.daybreak}
        />
      );
    });
  };

  it('keeps the panel collapsed until the layers button is pressed', () => {
    const onExpandedChange = jest.fn();
    act(() => {
      renderer = create(
        <MapLayersControl
          expanded={false}
          layers={layers}
          onChange={jest.fn()}
          onExpandedChange={onExpandedChange}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Highways layer' })).toHaveLength(0);

    act(() => renderer.root.findByProps({ accessibilityLabel: 'Map layers' }).props.onPress());
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  // The panel is a popover, and its open state belongs to the screen: only the screen can see the
  // tap on the map (or the drawer, or Settings) that should put it away.
  it('asks to close when its own button is pressed again', () => {
    const onExpandedChange = jest.fn();
    act(() => {
      renderer = create(
        <MapLayersControl
          expanded
          layers={layers}
          onChange={jest.fn()}
          onExpandedChange={onExpandedChange}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    act(() => renderer.root.findByProps({ accessibilityLabel: 'Map layers' }).props.onPress());
    expect(onExpandedChange).toHaveBeenCalledWith(false);
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

  it('toggles the transit layer on', () => {
    const onChange = jest.fn();
    expand(onChange);

    const row = renderer.root.findByProps({ accessibilityLabel: 'Transit layer' });
    expect(row.props.accessibilityState).toEqual({ checked: false });

    act(() => row.props.onPress());
    expect(onChange).toHaveBeenCalledWith('transit', true);
  });

  it('toggles the buildings layer off', () => {
    const onChange = jest.fn();
    expand(onChange);

    const row = renderer.root.findByProps({ accessibilityLabel: 'Buildings layer' });
    expect(row.props.accessibilityState).toEqual({ checked: true });

    act(() => row.props.onPress());
    expect(onChange).toHaveBeenCalledWith('structures', false);
  });
});
