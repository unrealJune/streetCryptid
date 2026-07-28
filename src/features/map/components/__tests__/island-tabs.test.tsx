import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { IslandTabs } from '../island-tabs';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

describe('IslandTabs', () => {
  let renderer: ReactTestRenderer;
  const SIGNAL = '#B06CE0';

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(active: 'me' | 'friends', onSelect = jest.fn(), signal = SIGNAL) {
    act(() => {
      renderer = create(
        <IslandTabs
          active={active}
          onSelect={onSelect}
          signal={signal}
          theme={CryptidThemes.daybreak}
        />
      );
    });
    return onSelect;
  }

  it('marks only the active tab as selected', () => {
    render('me');

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'ME' }).props.accessibilityState
    ).toEqual({ selected: true });
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'FRIENDS' }).props.accessibilityState
    ).toEqual({ selected: false });
  });

  it('reports the tab it was asked for', () => {
    const onSelect = render('me');

    act(() => renderer.root.findByProps({ accessibilityLabel: 'FRIENDS' }).props.onPress());

    expect(onSelect).toHaveBeenCalledWith('friends');
  });

  it('lets you re-select the tab you are on, which is how you leave a trace', () => {
    const onSelect = render('me');

    act(() => renderer.root.findByProps({ accessibilityLabel: 'ME' }).props.onPress());

    expect(onSelect).toHaveBeenCalledWith('me');
  });

  it('carries no presence badge — the roster header owns that, in words', () => {
    render('me');

    expect(renderer.root.findAllByProps({ testID: 'island-tab-presence-pip' })).toHaveLength(0);
  });

  it('wears your own signal colour on ME while ME is the open tab', () => {
    render('me');

    expect(renderer.root.findAllByProps({ tintColor: SIGNAL })).toHaveLength(1);
  });

  it('drops back to steel on ME once you are looking at friends', () => {
    render('friends');

    expect(renderer.root.findAllByProps({ tintColor: SIGNAL })).toHaveLength(0);
  });
});
