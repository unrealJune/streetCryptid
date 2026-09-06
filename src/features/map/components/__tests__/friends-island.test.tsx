import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { FriendsIsland, compactDistance, type MapRosterFriend } from '../friends-island';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

const mothman: MapRosterFriend = {
  id: 'endpoint-mothman',
  handle: '@wanderer',
  sigil: '/\\_/\\',
  cryptidName: 'Mothman',
  color: '#7de3b0',
  distanceM: 320,
  status: 'UPDATED 4 MIN AGO',
  online: true,
  nearby: true,
  locatable: true,
};

const jackalope: MapRosterFriend = {
  id: 'endpoint-jackalope',
  handle: '@nightowl',
  sigil: '(oo)',
  cryptidName: 'Jackalope',
  color: '#f0b429',
  distanceM: null,
  status: 'WAITING FOR LOCATION',
  online: false,
  nearby: false,
  locatable: false,
};

describe('FriendsIsland', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(
    friends: readonly MapRosterFriend[],
    onSelect = jest.fn(),
    onOpenProfile = jest.fn(),
    onToggleMinimize = jest.fn()
  ) {
    act(() => {
      renderer = create(
        <FriendsIsland
          friends={friends}
          minimized={false}
          onOpenProfile={onOpenProfile}
          onSelect={onSelect}
          onToggleMinimize={onToggleMinimize}
          theme={CryptidThemes.daybreak}
        />
      );
    });
    return { onSelect, onOpenProfile, onToggleMinimize };
  }

  it('lists every friend and counts only the near ones as nearby', () => {
    render([mothman, jackalope]);

    expect(findText(renderer, '@wanderer')).toHaveLength(1);
    // A friend who has gone dark stays in the roster rather than vanishing.
    expect(findText(renderer, '@nightowl')).toHaveLength(1);
    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
  });

  it('shows distance for live friends and OFFLINE for dark ones', () => {
    render([mothman, jackalope]);

    expect(findText(renderer, '320 M')).toHaveLength(1);
    expect(findText(renderer, 'OFFLINE')).toHaveLength(1);
  });

  it('renders the pairing readout the island arms', () => {
    act(() => {
      renderer = create(
        <FriendsIsland
          friends={[]}
          minimized={false}
          onOpenProfile={jest.fn()}
          onSelect={jest.fn()}
          onToggleMinimize={jest.fn()}
          pairing={<Text>SEARCHING FOR A BUMP</Text>}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    expect(findText(renderer, 'SEARCHING FOR A BUMP')).toHaveLength(1);
  });

  it('flies to a friend when their row is tapped', () => {
    const { onSelect } = render([mothman, jackalope]);

    const row = renderer.root.findByProps({
      accessibilityLabel: '@wanderer. 320 m. updated 4 min ago.',
    });
    act(() => row.props.onPress());

    expect(onSelect).toHaveBeenCalledWith('endpoint-mothman');
  });

  it('opens friend management from its own target, not the row', () => {
    const { onSelect, onOpenProfile } = render([mothman]);

    const manage = renderer.root.findByProps({
      accessibilityLabel: 'Manage @wanderer',
    });
    act(() => manage.props.onPress());

    expect(onOpenProfile).toHaveBeenCalledWith('endpoint-mothman');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps the profile reachable for friends with no fix to fly to', () => {
    render([jackalope]);

    const row = renderer.root.findByProps({
      accessibilityLabel: '@nightowl. offline. waiting for location.',
    });
    expect(row.props.accessibilityState).toEqual({ disabled: true });
    expect(row.props.disabled).toBe(true);
    // Management stays live: removing a friend must not depend on their GPS.
    const manage = renderer.root.findByProps({
      accessibilityLabel: 'Manage @nightowl',
    });
    expect(manage.props.disabled).toBeUndefined();
  });

  it('leaves a reachable but distant friend out of the count, and in the list', () => {
    // Online, so the row is live and shows a distance — but 40 km away is not NEARBY.
    const faraway: MapRosterFriend = {
      ...mothman,
      id: 'endpoint-faraway',
      handle: '@faraway',
      distanceM: 40_000,
      nearby: false,
    };
    render([mothman, faraway]);

    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
    expect(findText(renderer, '@faraway')).toHaveLength(1);
    expect(findText(renderer, '40 KM')).toHaveLength(1);
  });

  it('collapses to the header line, on the same chevron ME uses', () => {
    const { onToggleMinimize } = render([mothman, jackalope]);

    const minimize = renderer.root.findByProps({ accessibilityLabel: 'Minimize friends roster' });
    expect(minimize.props.accessibilityState).toEqual({ expanded: true });
    act(() => minimize.props.onPress());
    expect(onToggleMinimize).toHaveBeenCalledTimes(1);

    // The screen owns the state, so re-render with it applied.
    act(() => {
      renderer.update(
        <FriendsIsland
          friends={[mothman, jackalope]}
          minimized
          onOpenProfile={jest.fn()}
          onSelect={jest.fn()}
          onToggleMinimize={onToggleMinimize}
          pairing={<Text>SEARCHING FOR A BUMP</Text>}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    // Header line only: the count survives, the roster and the pairing strip do not.
    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
    expect(findText(renderer, '@wanderer')).toHaveLength(0);
    expect(findText(renderer, 'SEARCHING FOR A BUMP')).toHaveLength(0);
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Expand friends roster' }).props
        .accessibilityState
    ).toEqual({ expanded: false });
  });

  it('points an empty atlas at pairing instead of showing a bare list', () => {
    render([]);

    expect(findText(renderer, '0 NEARBY')).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType(Text)
        .some((node) => String(node.props.children).includes('Touch two phones together'))
    ).toBe(true);
  });
});

describe('compactDistance', () => {
  it('rounds to a precision the fix supports', () => {
    expect(compactDistance(0)).toBe('0 M');
    expect(compactDistance(324)).toBe('320 M');
    expect(compactDistance(949)).toBe('950 M');
    expect(compactDistance(1240)).toBe('1.2 KM');
    expect(compactDistance(24_600)).toBe('25 KM');
  });

  it('has nothing to say without a distance', () => {
    expect(compactDistance(null)).toBeNull();
    expect(compactDistance(Number.NaN)).toBeNull();
  });
});

function findText(renderer: ReactTestRenderer, value: string) {
  return renderer.root.findAllByType(Text).filter((node) => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children.join('') === value;
  });
}
