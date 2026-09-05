import { act, create, type ReactTestRenderer } from 'react-test-renderer';

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
  transports: { relay: boolean; ip: boolean; ble: boolean };
  stash: { available: boolean; optedIn: boolean };
} = {
  transports: { relay: true, ip: true, ble: true },
  stash: { available: true, optedIn: true },
};

jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => ({ snapshot, refreshPairing: jest.fn() }),
}));

jest.mock('@/features/map/hooks/use-map-color-scheme', () => ({
  useMapColorScheme: () => ({ selected: { id: 'graphite', name: 'Graphite' } }),
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

  it('lists every settings area as its own page', () => {
    expect(rows().map((row) => row.href)).toEqual([
      '/settings/transports',
      '/settings/pairing',
      '/settings/delivery',
      '/settings/appearance',
      '/settings/app-data',
      '/settings/debug',
    ]);
  });

  it('summarises the state behind each page so the menu still answers "what is on"', () => {
    const byHref = new Map(rows().map((row) => [row.href, row.value]));

    expect(byHref.get('/settings/transports')).toBe('3/3 on');
    expect(byHref.get('/settings/delivery')).toBe('Stash on');
    expect(byHref.get('/settings/appearance')).toBe('Graphite');
  });

  it('distinguishes a stash that is off from one that was never deployed', () => {
    snapshot.stash = { available: true, optedIn: false };
    expect(rows().find((row) => row.href === '/settings/delivery')?.value).toBe('Stash off');

    act(() => renderer.unmount());
    snapshot.stash = { available: false, optedIn: false };
    expect(rows().find((row) => row.href === '/settings/delivery')?.value).toBe('No stash');

    snapshot.stash = { available: true, optedIn: true };
  });
});
