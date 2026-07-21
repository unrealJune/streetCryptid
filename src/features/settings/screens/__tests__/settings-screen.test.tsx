import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import SettingsScreen from '../settings-screen';

const mockRefreshPairing = jest.fn(() => Promise.resolve());
const mockRefreshTransportDiagnostics = jest.fn(() => Promise.resolve());

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => ({
    snapshot: null,
    transportReport: { rows: [], updatedAt: null, error: null },
    refreshPairing: mockRefreshPairing,
    refreshTransportDiagnostics: mockRefreshTransportDiagnostics,
    setStashOptIn: jest.fn(),
    setRelayOnly: jest.fn(),
    disclosureStatus: 'accepted',
    acknowledgeLocationDisclosure: jest.fn(),
  }),
}));

describe('SettingsScreen', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    jest.useFakeTimers();
    mockRefreshPairing.mockClear();
    mockRefreshTransportDiagnostics.mockClear();
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  it('renders and refreshes transport diagnostics while mounted', () => {
    act(() => {
      renderer = create(<SettingsScreen />);
    });

    expect(
      renderer.root.findAllByType(Text).some((node) => node.props.children === 'Settings')
    ).toBe(true);
    expect(mockRefreshPairing).toHaveBeenCalledTimes(1);
    expect(mockRefreshTransportDiagnostics).toHaveBeenCalledTimes(1);

    act(() => jest.advanceTimersByTime(1000));
    expect(mockRefreshTransportDiagnostics).toHaveBeenCalledTimes(2);

    act(() => renderer.unmount());
    act(() => jest.advanceTimersByTime(1000));
    expect(mockRefreshTransportDiagnostics).toHaveBeenCalledTimes(2);
  });
});
