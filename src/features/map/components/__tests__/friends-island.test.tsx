import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';
import type { DistanceUnit } from '@/features/settings/core/distance-units';

import { FriendsIsland, compactDistance, type MapRosterFriend } from '../friends-island';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));
let mockDistanceUnit: DistanceUnit = 'km';
let mockDisplayPreferencesReady = true;
jest.mock('@/features/settings/hooks/use-display-preferences', () => ({
  useDisplayPreferences: () => ({
    distanceUnit: mockDistanceUnit,
    ready: mockDisplayPreferencesReady,
  }),
}));

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

  beforeEach(() => {
    mockDistanceUnit = 'km';
    mockDisplayPreferencesReady = true;
  });

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(
    friends: readonly MapRosterFriend[],
    onSelect = jest.fn(),
    onOpenProfile = jest.fn(),
    onOpenPairing = jest.fn()
  ) {
    act(() => {
      renderer = create(
        <FriendsIsland
          friends={friends}
          minimized={false}
          onOpenPairing={onOpenPairing}
          onOpenProfile={onOpenProfile}
          onSelect={onSelect}
          theme={CryptidThemes.daybreak}
        />
      );
    });
    return { onSelect, onOpenProfile, onOpenPairing };
  }

  it('lists every friend and counts only the near ones as nearby', () => {
    render([mothman, jackalope]);

    expect(findText(renderer, '@wanderer')).toHaveLength(1);
    // A friend who has gone dark stays in the roster rather than vanishing.
    expect(findText(renderer, '@nightowl')).toHaveLength(1);
    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
  });

  it('has no collapse control of its own — the drawer owns minimizing', () => {
    render([mothman]);

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Minimize friends roster' })
    ).toHaveLength(0);
    expect(findText(renderer, '@wanderer')).toHaveLength(1);
  });

  it('carries no status pip beside the count', () => {
    render([mothman, jackalope]);

    // The count is the whole signal. A pip beside it was a third place saying the same thing.
    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType(View)
        .filter((node) => StyleSheet.flatten(node.props.style)?.width === 10)
    ).toHaveLength(0);
  });

  it('shows distance for live friends and OFFLINE for dark ones', () => {
    render([mothman, jackalope]);

    expect(findText(renderer, '320 M')).toHaveLength(1);
    expect(findText(renderer, 'OFFLINE')).toHaveLength(1);
  });

  it('updates distance text and accessibility when the persisted unit preference changes', () => {
    const friends = [{ ...mothman, distanceM: 2000 }, jackalope];
    render(friends);
    expect(findText(renderer, '2.0 KM')).toHaveLength(1);

    mockDistanceUnit = 'mi';
    act(() => {
      renderer.update(
        <FriendsIsland
          friends={friends}
          minimized={false}
          onOpenPairing={jest.fn()}
          onOpenProfile={jest.fn()}
          onSelect={jest.fn()}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    expect(findText(renderer, '2.0 KM')).toHaveLength(0);
    expect(findText(renderer, '1.2 MI')).toHaveLength(1);
    expect(findText(renderer, 'OFFLINE')).toHaveLength(1);
    expect(
      renderer.root.findByProps({
        accessibilityLabel: '@wanderer. 1.2 mi. updated 4 min ago.',
      })
    ).toBeTruthy();
  });

  it('does not flash the default metric distance before the saved imperial preference hydrates', () => {
    mockDisplayPreferencesReady = false;
    const friends = [{ ...mothman, distanceM: 2000 }, jackalope];
    render(friends);

    expect(findText(renderer, '2.0 KM')).toHaveLength(0);
    expect(findText(renderer, '1.2 MI')).toHaveLength(0);
    expect(findText(renderer, 'NO FIX')).toHaveLength(0);
    expect(findText(renderer, 'OFFLINE')).toHaveLength(1);
    expect(
      renderer.root.findByProps({ accessibilityLabel: '@wanderer. updated 4 min ago.' })
    ).toBeTruthy();

    mockDistanceUnit = 'mi';
    mockDisplayPreferencesReady = true;
    act(() => {
      renderer.update(
        <FriendsIsland
          friends={friends}
          minimized={false}
          onOpenPairing={jest.fn()}
          onOpenProfile={jest.fn()}
          onSelect={jest.fn()}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    expect(findText(renderer, '2.0 KM')).toHaveLength(0);
    expect(findText(renderer, '1.2 MI')).toHaveLength(1);
    expect(
      renderer.root.findByProps({
        accessibilityLabel: '@wanderer. 1.2 mi. updated 4 min ago.',
      })
    ).toBeTruthy();
  });

  it('uses feet for nearby imperial distances without converting a missing fix', () => {
    mockDistanceUnit = 'mi';
    render([mothman, { ...jackalope, online: true }]);

    expect(findText(renderer, '1050 FT')).toHaveLength(1);
    expect(findText(renderer, 'NO FIX')).toHaveLength(1);
  });

  it('opens pairing from the one glyph on the header line, with no strip in the list', () => {
    const { onOpenPairing } = render([]);

    // The strip this replaced said the same thing twice and cost a row of roster to do it.
    expect(findText(renderer, 'PAIR WITH SOMEONE')).toHaveLength(0);
    expect(findText(renderer, 'OPEN PAIRING')).toHaveLength(0);

    const add = renderer.root.findByProps({ accessibilityLabel: 'Open pairing' });
    act(() => add.props.onPress());
    expect(onOpenPairing).toHaveBeenCalledTimes(1);
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

  it('collapses to the count alone, the way ME collapses to place and percent', () => {
    render([mothman, jackalope]);

    // `minimized` is the drawer's `collapsed` detent, so the screen supplies it.
    act(() => {
      renderer.update(
        <FriendsIsland
          friends={[mothman, jackalope]}
          minimized
          onOpenPairing={jest.fn()}
          onOpenProfile={jest.fn()}
          onSelect={jest.fn()}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    // One line: the count survives, the roster does not.
    expect(findText(renderer, '1 NEARBY')).toHaveLength(1);
    expect(findText(renderer, '@wanderer')).toHaveLength(0);
    // Adding someone stays reachable at the smallest size — an empty roster is at its emptiest
    // exactly when the panel is smallest.
    expect(renderer.root.findByProps({ accessibilityLabel: 'Open pairing' })).toBeTruthy();
  });

  it('keeps the empty roster copy brief, without duplicate pairing instructions', () => {
    render([]);

    expect(findText(renderer, '0 NEARBY')).toHaveLength(1);
    expect(findText(renderer, 'No cryptids yet!')).toHaveLength(1);
    expect(
      renderer.root
        .findAllByType(Text)
        .some((node) => String(node.props.children).includes('Touch two phones together'))
    ).toBe(false);
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

  it('uses the shared imperial formatter while preserving uppercase roster styling', () => {
    expect(compactDistance(110, 'mi')).toBe('360 FT');
    expect(compactDistance(2000, 'mi')).toBe('1.2 MI');
    expect(compactDistance(40_000, 'mi')).toBe('25 MI');
    expect(compactDistance(null, 'mi')).toBeNull();
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
