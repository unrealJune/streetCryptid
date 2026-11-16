import { Platform, Switch } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DeliveryOptions } from '../delivery-options';

jest.mock('@/global.css', () => ({}));
jest.mock('../delivery-preview', () => ({ DeliveryPreview: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('DeliveryOptions', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('shows the platform-specific mutual friend relay warning without secondary copy', () => {
    act(() => {
      renderer = create(
        <DeliveryOptions
          selected="mutual"
          availability={{ stashConfigured: true }}
          onSelect={jest.fn()}
        />
      );
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Mutual friend relay');
    expect(json).toContain(`background processing on ${Platform.OS === 'ios' ? 'iOS' : 'Android'}`);
    expect(json).not.toContain('They cannot read');
    expect(json).not.toContain('shared pool');
  });

  it('names stash honestly and keeps unavailable stored choices visible', () => {
    act(() => {
      renderer = create(
        <DeliveryOptions
          selected="stash"
          availability={{ stashConfigured: false }}
          onSelect={jest.fn()}
        />
      );
    });
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Mutuals + Stash Server');
    expect(json).toContain('Stash entries are encrypted');
    expect(json).toContain('No stash server is configured');
    expect(json).not.toContain('30 minutes');
    // On a build with no stash the switch shows, off and inert.
    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props.value).toBe(false);
  });

  it('is one switch: the stash carries my trail, or friends alone do', () => {
    const onSelect = jest.fn();
    act(() => {
      renderer = create(
        <DeliveryOptions
          selected="mutual"
          availability={{ stashConfigured: true }}
          onSelect={onSelect}
          footnote="repeaters live elsewhere"
        />
      );
    });
    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);
    act(() => toggle.props.onValueChange(true));
    expect(onSelect).toHaveBeenLastCalledWith('stash');
    act(() => toggle.props.onValueChange(false));
    expect(onSelect).toHaveBeenLastCalledWith('mutual');
    expect(JSON.stringify(renderer.toJSON())).toContain('for at most 48 hours');
    expect(JSON.stringify(renderer.toJSON())).toContain('repeaters live elsewhere');
  });
});
