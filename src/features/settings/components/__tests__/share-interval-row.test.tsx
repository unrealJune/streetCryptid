import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SHARE_INTERVAL_OPTIONS_MS } from '@/features/social/net/persistence';

import { ShareIntervalRow } from '../share-interval-row';

jest.mock('@/global.css', () => ({}));

describe('ShareIntervalRow', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(intervalMs: number, onSelect = jest.fn()) {
    act(() => {
      renderer = create(
        <ShareIntervalRow accent="#C6791A" intervalMs={intervalMs} onSelect={onSelect} />
      );
    });
    // Queried by role rather than by component type: RN's Pressable is a memo(forwardRef(...)),
    // which findAllByType cannot match. `deep: false` stops at the outermost match per option —
    // Pressable propagates its props down its own rendered tree, so a deep search returns each
    // option three times.
    return {
      onSelect,
      options: renderer.root.findAll((node) => node.props.accessibilityRole === 'radio', {
        deep: false,
      }),
    };
  }

  it('offers one accessible option per supported interval', () => {
    const { options } = render(300_000);

    expect(options).toHaveLength(SHARE_INTERVAL_OPTIONS_MS.length);
    expect(options.map((item) => item.props.accessibilityLabel)).toEqual([
      'Update every 1 MIN',
      'Update every 5 MIN',
      'Update every 15 MIN',
    ]);
  });

  it('marks only the active interval as selected', () => {
    const { options } = render(900_000);

    expect(options.map((item) => item.props.accessibilityState.selected)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('reports the chosen interval in milliseconds', () => {
    const { onSelect, options } = render(300_000);

    act(() => options[0].props.onPress());

    expect(onSelect).toHaveBeenCalledWith(60_000);
  });
});
