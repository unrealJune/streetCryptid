import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';
import type { DrawerDetent } from '@/features/map/core/drawer-detents';

import { FriendDetailIsland } from '../friend-detail-island';
import { buildFriendPresence } from '../../core/presence';
import { FIX_STATE_PARKED, type Friend, type LocationFix } from '../../core/types';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

const NOW = 1_000_000;

const tallgrass: Friend = {
  endpointId: 'aabb',
  handle: '@tallgrass',
  sigil: '(oo)',
  cryptidName: 'Jackalope',
  recvPublic: 'aabb-recv',
  ticket: 'aabb-ticket',
  pairingMethod: 'nearby',
};

const selfFix: LocationFix = {
  lat: 47.62,
  lon: -122.32,
  accuracyM: 5,
  headingDeg: 0,
  ts: NOW,
};

/** A friend parked 12 minutes ago, ~1.2 km north — the case the presence model exists for. */
function parkedPresence() {
  const [presence] = buildFriendPresence({
    friends: [tallgrass],
    latest: [
      {
        author: 'aabb',
        fix: {
          ...selfFix,
          lat: 47.6308,
          ts: NOW - 12 * 60 * 1000,
          state: FIX_STATE_PARKED,
          publishedDeltaS: 11 * 60,
        },
        receivedAt: NOW,
        via: 'stash',
      },
    ],
    selfFix,
    now: NOW,
  });
  return presence;
}

describe('FriendDetailIsland', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(detent: DrawerDetent, overrides: { sharing?: boolean } = {}) {
    const onBack = jest.fn();
    const onToggleShare = jest.fn().mockResolvedValue(undefined);
    const onRemove = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(
        <FriendDetailIsland
          detent={detent}
          onBack={onBack}
          onRemove={onRemove}
          onToggleShare={onToggleShare}
          placeName="Volunteer Park"
          presence={parkedPresence()}
          sharing={overrides.sharing ?? true}
          theme={CryptidThemes.daybreak}
        />
      );
    });
    return { onBack, onToggleShare, onRemove };
  }

  it('leads with where they are, not with how the app knows', () => {
    render('peek');

    expect(findText(renderer, 'Volunteer Park')).toHaveLength(1);
    expect(findText(renderer, '@tallgrass')).toHaveLength(1);
    // State and distance ride one sub line, which is why there is no LOCATION row to duplicate it.
    expect(findText(renderer, 'PARKED HERE 12 MIN · 1.2 KM')).toHaveLength(1);
    expect(findText(renderer, 'LOCATION')).toHaveLength(0);
  });

  it('keeps sharing out of the peek and offers it once expanded', () => {
    render('peek');
    // `deep: false` keeps this to the Pressable itself rather than the host views it renders.
    expect(
      renderer.root.findAllByProps({ accessibilityRole: 'switch' }, { deep: false })
    ).toHaveLength(0);

    act(() => renderer?.unmount());
    render('mid');
    expect(
      renderer.root.findAllByProps({ accessibilityRole: 'switch' }, { deep: false })
    ).toHaveLength(1);
  });

  it('states whether sharing is on rather than naming the opposite action', () => {
    render('mid', { sharing: true });

    const control = renderer.root.findByProps({ accessibilityRole: 'switch' });
    expect(control.props.accessibilityState).toMatchObject({ checked: true });
    expect(findText(renderer, 'ON')).toHaveLength(1);
    expect(findText(renderer, 'PAUSE SHARING')).toHaveLength(0);
  });

  it('toggles sharing to the opposite of what it currently is', async () => {
    const { onToggleShare } = render('mid', { sharing: true });

    await act(async () => {
      renderer.root.findByProps({ accessibilityRole: 'switch' }).props.onPress();
    });

    expect(onToggleShare).toHaveBeenCalledWith(false);
  });

  it('holds removal back until the drawer is fully open, behind a confirm', () => {
    render('mid');
    expect(findText(renderer, 'REMOVE FRIEND')).toHaveLength(0);

    act(() => renderer?.unmount());
    const { onRemove } = render('full');
    const remove = renderer.root.findByProps({
      accessibilityHint: 'Stops sharing and removes this friend from your atlas',
    });
    act(() => remove.props.onPress());

    // One tap asks; it does not remove.
    expect(onRemove).not.toHaveBeenCalled();
    expect(findText(renderer, 'Remove @tallgrass?')).toHaveLength(1);
  });

  it('offers one way back, not a back control and a close button', () => {
    const { onBack } = render('peek');

    const back = renderer.root.findByProps({ accessibilityLabel: 'Back to friends' });
    act(() => back.props.onPress());

    expect(onBack).toHaveBeenCalled();
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Close friend profile' }, { deep: false })
    ).toHaveLength(0);
  });

  it('has no centre-map button, because opening the pane already moved the map', () => {
    render('full');

    const labels = renderer.root
      .findAllByType(Text)
      .map((node) => String(node.props.children))
      .join(' ')
      .toUpperCase();
    expect(labels).not.toContain('CENTRE MAP');
    expect(labels).not.toContain('VIEW ON MAP');
  });

  it('survives a friend whose place has no name yet', () => {
    act(() => {
      renderer = create(
        <FriendDetailIsland
          detent="peek"
          onBack={jest.fn()}
          onRemove={jest.fn()}
          onToggleShare={jest.fn()}
          placeName={null}
          presence={parkedPresence()}
          sharing={false}
          theme={CryptidThemes.daybreak}
        />
      );
    });

    expect(findText(renderer, '—')).toHaveLength(1);
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
