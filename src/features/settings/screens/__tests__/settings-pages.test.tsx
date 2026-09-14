import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SettingsMenuRow } from '../../components/settings-menu-row';
import { SettingsPage, SettingsSection } from '../../components/settings-page';
import { DeliveryOptions } from '../../components/delivery-options';
import { FriendConnectionDetailsRow } from '../../components/friend-connection-details-row';
import AdvancedScreen from '../advanced-screen';
import AppearanceScreen from '../appearance-screen';
import AppDataScreen from '../app-data-screen';
import DebugScreen from '../debug-screen';
import DeliveryScreen from '../delivery-screen';
import TransportsScreen from '../transports-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
  useFocusEffect: () => {},
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/features/map/hooks/use-exploration-backup', () => ({
  useExplorationBackup: () => ({ busy: false, exportBackup: jest.fn(), restoreBackup: jest.fn() }),
}));
jest.mock('../../components/map-color-scheme-row', () => ({ MapColorSchemeRow: () => null }));
jest.mock('../../components/distance-units-row', () => ({ DistanceUnitsRow: () => null }));
jest.mock('../../components/delivery-options', () => ({ DeliveryOptions: () => null }));
jest.mock('../../components/debug-location-controls', () => ({
  DebugLocationControls: () => null,
}));
jest.mock('../../components/friend-connection-details-row', () => ({
  FriendConnectionDetailsRow: () => null,
}));
jest.mock('../../components/event-log-panel', () => ({ EventLogPanel: () => null }));

const mockSetDelivery = jest.fn().mockResolvedValue(undefined);
const mockSetShareInterval = jest.fn();
jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => ({
    snapshot: { delivery: { mode: 'mutual', stashConfigured: true } },
    transportReport: { rows: [], error: null, updatedAt: null },
    refreshTransportDiagnostics: jest.fn(),
    setDeliveryMode: mockSetDelivery,
    setShareInterval: mockSetShareInterval,
    disclosureStatus: 'accepted',
    acknowledgeLocationDisclosure: jest.fn(),
    forceLocationPush: jest.fn(),
  }),
}));

describe('settings pages', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  it('groups transports and debug under Advanced', () => {
    act(() => {
      renderer = create(<AdvancedScreen />);
    });
    expect(renderer.root.findAllByType(SettingsMenuRow).map((row) => row.props.label)).toEqual([
      'Transports',
      'Debug',
    ]);
  });

  it('does not repeat appearance headings or subtitles', () => {
    act(() => {
      renderer = create(<AppearanceScreen />);
    });
    expect(renderer.root.findByType(SettingsPage).props.subtitle).toBeUndefined();
    expect(
      renderer.root.findAllByType(SettingsSection).map((section) => section.props.label)
    ).toEqual(['DISTANCE UNITS']);
  });

  it('groups backups separately from app provenance', () => {
    act(() => {
      renderer = create(<AppDataScreen />);
    });
    expect(renderer.root.findByType(SettingsPage).props.subtitle).toBeUndefined();
    expect(
      renderer.root.findAllByType(SettingsSection).map((section) => section.props.label)
    ).toEqual(['BACKUPS', 'APP']);
    expect(JSON.stringify(renderer.toJSON())).toContain('Export is unencrypted');
  });

  it('shows enabled transports before detailed status', () => {
    act(() => {
      renderer = create(<TransportsScreen />);
    });
    expect(
      renderer.root.findAllByType(SettingsSection).map((section) => section.props.label)
    ).toEqual(['ENABLED TRANSPORTS', 'DETAILED STATUS']);
    expect(renderer.root.findByType(SettingsPage).props.subtitle).toBeUndefined();
  });

  it('offers friend diagnostics without the onboarding preview', () => {
    act(() => {
      renderer = create(<DebugScreen />);
    });
    expect(renderer.root.findAllByType(FriendConnectionDetailsRow)).toHaveLength(1);
    expect(
      renderer.root.findAllByType(SettingsSection).map((section) => section.props.label)
    ).not.toContain('ONBOARDING');
  });

  it('changes delivery without exposing or changing the underlying cadence', async () => {
    act(() => {
      renderer = create(<DeliveryScreen />);
    });
    expect(renderer.root.findByType(SettingsPage).props.subtitle).toBeUndefined();
    expect(
      renderer.root.findAllByType(SettingsSection).map((section) => section.props.label)
    ).toEqual(['ACCESS']);
    await act(async () => renderer.root.findByType(DeliveryOptions).props.onSelect('stash'));
    expect(mockSetDelivery).toHaveBeenCalledWith('stash');
    expect(mockSetShareInterval).not.toHaveBeenCalled();
  });
});
