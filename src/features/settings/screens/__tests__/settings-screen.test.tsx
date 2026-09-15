import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { DeliveryMode } from '@/features/social/core/delivery-mode';
import SettingsScreen from '../settings-screen';
import { SettingsMenuRow } from '../../components/settings-menu-row';

jest.mock('@/global.css', () => ({}));

// The menu is the unit under test; identity is its own component with its own test,
// and it drags the profile store and the avatar renderer in behind it.
jest.mock('../../components/identity-row', () => ({ IdentityRow: () => null }));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: () => {},
}));

const snapshot: {
  friends: { id: string }[];
  transports: { relay: boolean; ip: boolean; ble: boolean };
  delivery: { mode: DeliveryMode; effectiveMode: DeliveryMode };
} = {
  friends: [],
  transports: { relay: true, ip: true, ble: true },
  delivery: { mode: 'stash', effectiveMode: 'stash' },
};

jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => ({ snapshot, refreshPairing: jest.fn() }),
}));

// A real scheme: `useTheme()` now retints every chrome token from the selected palette, so the
// menu cannot render against a name-only stub.
jest.mock('@/features/map/hooks/use-map-color-scheme', () => ({
  useMapColorScheme: () => ({
    selected: jest.requireActual('@/features/map/theme/map-color-schemes')
      .BUILT_IN_MAP_COLOR_SCHEMES[0],
  }),
}));

describe('SettingsScreen', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function rows() {
    act(() => {
      renderer = create(<SettingsScreen />);
    });
    return renderer.root.findAllByType(SettingsMenuRow).map((row) => row.props);
  }

  it('lists every settings area as its own page, sharing before this phone', () => {
    // The order is the menu's argument: everything above the line changes what your
    // friends receive, everything below it changes nothing outside this install.
    expect(rows().map((row) => row.href)).toEqual([
      '/settings/delivery',
      '/pairing',
      '/settings/appearance',
      '/settings/advanced',
      '/settings/app-data',
    ]);
  });

  it('summarises the state behind each page so the menu still answers "what is on"', () => {
    const byHref = new Map(rows().map((row) => [row.href, row.value]));

    expect(byHref.has('/settings/transports')).toBe(false);
    expect(byHref.get('/settings/delivery')).toBe('Mutuals + Stash Server');
    expect(byHref.get('/settings/appearance')).toBe('Seattle · Light');
    // Transports moved behind Advanced, so Advanced is where their state has to surface:
    // a row that reports nothing is what made this menu look unfinished.
    expect(byHref.get('/settings/advanced')).toBe('Relay · Direct · BLE');
    expect(byHref.get('/pairing')).toBe('Nobody paired yet');
  });

  it('names only the transports that are permitted, and says so when none are', () => {
    snapshot.transports = { relay: true, ip: false, ble: true };
    expect(rows().find((row) => row.href === '/settings/advanced')?.value).toBe('Relay · BLE');

    act(() => renderer.unmount());
    snapshot.transports = { relay: false, ip: false, ble: false };
    expect(rows().find((row) => row.href === '/settings/advanced')?.value).toBe(
      'No transports enabled'
    );

    snapshot.transports = { relay: true, ip: true, ble: true };
  });

  it('counts the friends behind the pairing entry', () => {
    snapshot.friends = [{ id: 'a' }];
    expect(rows().find((row) => row.href === '/pairing')?.value).toBe('1 friend');

    act(() => renderer.unmount());
    snapshot.friends = [{ id: 'a' }, { id: 'b' }];
    expect(rows().find((row) => row.href === '/pairing')?.value).toBe('2 friends');

    snapshot.friends = [];
  });

  it('names the route that is actually in use, not the one that was asked for', () => {
    // A build with no stash deployed uses mutual friends whatever the stored preference says,
    // and the menu is a summary of what is happening.
    snapshot.delivery = { mode: 'stash', effectiveMode: 'mutual' };
    expect(rows().find((row) => row.href === '/settings/delivery')?.value).toBe('Mutual Friends');

    act(() => renderer.unmount());
    snapshot.delivery = { mode: 'stash', effectiveMode: 'stash' };
    expect(rows().find((row) => row.href === '/settings/delivery')?.value).toBe(
      'Mutuals + Stash Server'
    );

    snapshot.delivery = { mode: 'stash', effectiveMode: 'stash' };
  });

  it('keeps menu entries free of subtitles', () => {
    expect(rows().every((row) => row.detail === undefined)).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('Identity, transports');
  });
});
