import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import {
  deliveryModeOptions,
  type DeliveryAvailability,
} from '@/features/social/core/delivery-mode';

import { DeliveryModePicker } from '../delivery-mode-picker';

jest.mock('@/global.css', () => ({}));

const ALL: DeliveryAvailability = { stashConfigured: true, mutualSupported: true };
const NO_STASH: DeliveryAvailability = { stashConfigured: false, mutualSupported: true };

describe('DeliveryModePicker', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(availability: DeliveryAvailability, selected: 'direct' | 'mutual' | 'stash') {
    const onSelect = jest.fn();
    act(() => {
      renderer = create(
        <DeliveryModePicker
          accent="#2f9e6a"
          options={deliveryModeOptions(availability)}
          selected={selected}
          onSelect={onSelect}
        />
      );
    });
    return {
      onSelect,
      segment: (id: string) => renderer.root.findByProps({ testID: `delivery-mode-${id}` }),
    };
  }

  it('offers all three routes and reports the selected one', () => {
    const { segment } = render(ALL, 'mutual');

    expect(segment('direct').props.accessibilityState.selected).toBe(false);
    expect(segment('mutual').props.accessibilityState.selected).toBe(true);
    expect(segment('stash').props.accessibilityState.selected).toBe(false);
  });

  it('reports the choice by id, not by index', () => {
    const { onSelect, segment } = render(ALL, 'direct');

    act(() => segment('stash').props.onPress());
    expect(onSelect).toHaveBeenCalledWith('stash');
  });

  it('still shows a route this build cannot offer, but refuses to select it', () => {
    // Hiding it would leave the screen describing two options to someone who was told there
    // are three, with no explanation of where the third went.
    const { onSelect, segment } = render(NO_STASH, 'direct');

    const stash = segment('stash');
    expect(stash.props.accessibilityState.disabled).toBe(true);
    expect(stash.props.disabled).toBe(true);
    expect(stash.props.accessibilityHint).toBe('Not available on this build');

    act(() => stash.props.onPress?.());
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('labels each segment for a screen reader with words, not initials', () => {
    const { segment } = render(ALL, 'direct');
    expect(segment('mutual').props.accessibilityLabel).toBe('Mutual relay delivery');
  });
});
