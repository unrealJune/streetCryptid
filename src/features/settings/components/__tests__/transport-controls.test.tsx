import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Switch } from 'react-native';

import { TransportControls } from '../transport-controls';

jest.mock('@/global.css', () => ({}));

describe('TransportControls', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('exposes one accessible toggle per native transport', () => {
    const onToggle = jest.fn();
    act(() => {
      renderer = create(
        <TransportControls
          accent="#2f9e6a"
          preferences={{ relay: true, ip: true, ble: false }}
          onToggle={onToggle}
        />
      );
    });

    const switches = renderer.root.findAllByType(Switch);
    expect(switches.map((item) => item.props.accessibilityLabel)).toEqual([
      'Relay transport',
      'Direct IP / LAN transport',
      'Bluetooth LE transport',
    ]);

    act(() => switches[2].props.onValueChange(true));
    expect(onToggle).toHaveBeenCalledWith('ble', true);
  });

  it('keeps the final enabled transport on', () => {
    act(() => {
      renderer = create(
        <TransportControls
          accent="#2f9e6a"
          preferences={{ relay: true, ip: false, ble: false }}
          onToggle={jest.fn()}
        />
      );
    });

    expect(renderer.root.findAllByType(Switch)[0].props.disabled).toBe(true);
  });
});
