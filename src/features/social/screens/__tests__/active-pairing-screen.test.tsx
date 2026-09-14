import { Share } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { PairingSnapshot } from '../../net/location-sharing';
import ActivePairingScreen from '../active-pairing-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => {}) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-reanimated', () => {
  const { View, Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View, Text },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
    LinearTransition: { duration: () => undefined },
    useReducedMotion: () => true,
  };
});
jest.mock('../../components/pressable-action', () => ({
  PressableAction: jest.requireActual('react-native').Pressable,
}));
jest.mock('../../components/pairing-signal-field', () => ({
  PairingSignalField: () => null,
}));
jest.mock('../../components/pairing-qr', () => ({ PairingQr: () => null }));
jest.mock('../../components/pairing-figure-view', () => ({
  PairingFigureView: () => null,
  PairingFigureChoices: () => null,
}));
jest.mock('../../components/persona-reveal', () => ({ PersonaReveal: () => null }));
jest.mock('@/features/social/net/bluetooth-settings', () => ({ openBluetoothSettings: jest.fn() }));
jest.mock('@/features/social/net/location-sharing', () => ({
  TERMINAL_PAIR_STATES: ['complete', 'rejected', 'failed'],
}));
jest.mock('@/features/haptics/haptics', () => ({
  patternHaptic: jest.fn(async () => {}),
  successHaptic: jest.fn(async () => {}),
  tapHaptic: jest.fn(async () => {}),
  warningHaptic: jest.fn(async () => {}),
}));
jest.mock('@/features/social/hooks/use-armed-bump', () => ({
  useArmedBump: () => ({
    arming: false,
    error: null,
    sensor: { status: 'ready' },
    arm: jest.fn(async () => {}),
  }),
}));
jest.mock('@/features/social/hooks/use-pairing-haptics', () => ({
  usePairingHaptics: () => {},
}));
const mockRouter = { back: jest.fn(), setParams: jest.fn() };
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => ({}),
  useRouter: () => mockRouter,
  useFocusEffect: (effect: () => () => void) => {
    jest.requireActual('react').useEffect(effect, [effect]);
  },
}));

function pairing(): PairingSnapshot {
  return {
    available: true,
    ready: true,
    radio: 'poweredOn',
    capabilities: null,
    nearbyPeers: [],
    sessions: [],
    pendingRequests: [],
    verifications: [],
    bump: { stage: 'armed', expiresAt: null, rssi: null, peerCount: 0, error: null },
    discoveredFriend: null,
    inviteLink: null,
    inviteExpiresAt: null,
    activity: '',
  };
}

const mockSharing = {
  snapshot: { ready: true },
  pairing: pairing(),
  createPairInvite: jest.fn<Promise<string | undefined>, [number]>(),
  cancelPairInvite: jest.fn<Promise<'cancelled' | 'absent' | 'unsupported'>, []>(),
  pairFromInput: jest.fn(async () => {}),
  cancelBump: jest.fn(async () => {}),
  clearPairingFailure: jest.fn(),
  submitPairChoice: jest.fn(async () => {}),
  confirmPairDisplay: jest.fn(async () => {}),
  cancelPair: jest.fn(async () => {}),
  refreshPairing: jest.fn(async () => {}),
  acknowledgeDiscoveredFriend: jest.fn(async () => {}),
  rejectDiscoveredFriend: jest.fn(async () => {}),
};
jest.mock('@/features/social/hooks/use-location-sharing', () => ({
  useLocationSharing: () => mockSharing,
}));

const LINK = 'https://streetcrypt.id/pair#token=scpair2:cafef00d';

describe('ActivePairingScreen', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSharing.pairing = pairing();
    mockSharing.cancelPairInvite.mockResolvedValue('cancelled');
    mockSharing.createPairInvite.mockResolvedValue(LINK);
    mockSharing.acknowledgeDiscoveredFriend.mockResolvedValue(undefined);
    mockSharing.rejectDiscoveredFriend.mockResolvedValue(undefined);
    jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  async function renderLiveLink() {
    mockSharing.pairing = {
      ...pairing(),
      inviteLink: LINK,
      inviteExpiresAt: Date.now() + 120_000,
    };
    await act(async () => {
      renderer = create(<ActivePairingScreen />);
    });
  }

  function action(label: string) {
    return renderer.root.findAllByProps({ accessibilityLabel: label })[0];
  }

  async function renderDiscovery() {
    mockSharing.pairing.discoveredFriend = {
      endpointId: 'peer',
      recvPublic: 'key',
      ticket: 'ticket',
      handle: '@morgan',
      sigil: ':)',
      pairedAt: 1,
    };
    await act(async () => {
      renderer = create(<ActivePairingScreen />);
    });
  }

  it('waits for rejection, prevents a simultaneous acknowledgement, and then closes', async () => {
    let finish = () => {};
    mockSharing.rejectDiscoveredFriend.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    await renderDiscovery();
    await act(async () => {
      action('reject').props.onPress();
      action('acknowledge').props.onPress();
      action('reject').props.onPress();
    });
    expect(mockSharing.rejectDiscoveredFriend).toHaveBeenCalledTimes(1);
    expect(mockSharing.acknowledgeDiscoveredFriend).not.toHaveBeenCalled();
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('shows rejection failures without closing or enabling acknowledgement', async () => {
    await renderDiscovery();
    mockSharing.rejectDiscoveredFriend.mockRejectedValueOnce(new Error('Could not cancel pairing'));
    await act(async () => action('reject').props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not cancel pairing');
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(action('acknowledge').props.disabled).toBe(true);
    await act(async () => action('reject').props.onPress());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('waits for acknowledgement and reports persistence failures', async () => {
    await renderDiscovery();
    mockSharing.acknowledgeDiscoveredFriend.mockRejectedValueOnce(
      new Error('Could not save friend')
    );
    await act(async () => action('acknowledge').props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not save friend');
    expect(mockRouter.back).not.toHaveBeenCalled();
    await act(async () => action('acknowledge').props.onPress());
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('never cancels an acknowledged discovery whose native session snapshot is stale', async () => {
    mockSharing.pairing.sessions = [
      {
        sessionId: 'completed',
        peerEndpointId: 'peer',
        state: 'localAccepted',
        localAccepted: true,
        peerAccepted: false,
        sasVerified: true,
        localSasConfirmed: true,
        initiator: true,
        nearby: true,
      },
    ];
    mockSharing.pairing.completedSessionIds = ['completed'];
    await renderDiscovery();
    await act(async () => action('acknowledge').props.onPress());
    expect(mockSharing.acknowledgeDiscoveredFriend).toHaveBeenCalledTimes(1);
    expect(mockSharing.cancelPair).not.toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
  });

  it('treats closing an unconfirmed discovery as rejection, not silent acceptance', async () => {
    await renderDiscovery();
    await act(async () => action('Close pairing').props.onPress());
    expect(mockSharing.rejectDiscoveredFriend).toHaveBeenCalledTimes(1);
    expect(mockSharing.acknowledgeDiscoveredFriend).not.toHaveBeenCalled();
  });

  it('removes the top status and presents making a link as a secondary action', async () => {
    await act(async () => {
      renderer = create(<ActivePairingScreen />);
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('SHAKE TO ADD A NEARBY FRIEND');
    expect(text).toContain('SHAKE TO START');
    expect(text).not.toContain('BUMP ARMED');
    expect(text).not.toContain('top edges');
    const button = action('make a link');
    expect(button.props.style[1].backgroundColor).toBe('transparent');
  });

  it('cancels a live link exactly once and releases the screen', async () => {
    await renderLiveLink();
    const cancel = action('cancel link');
    await act(async () => {
      cancel.props.onPress();
      cancel.props.onPress();
    });
    expect(mockSharing.cancelPairInvite).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('SHAKE TO ADD A NEARBY FRIEND');
    expect(JSON.stringify(renderer.toJSON())).not.toContain(LINK);
  });

  it('keeps a link visible rather than claiming success when cancellation fails', async () => {
    await renderLiveLink();
    mockSharing.cancelPairInvite.mockRejectedValueOnce(new Error('Revocation failed'));
    await act(async () => action('cancel link').props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('Revocation failed');
    expect(JSON.stringify(renderer.toJSON())).toContain(LINK);

    mockSharing.cancelPairInvite.mockResolvedValueOnce('unsupported');
    await act(async () => action('cancel link').props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('cannot withdraw a link');
    expect(JSON.stringify(renderer.toJSON())).toContain(LINK);
  });

  it('does not share a link that finishes minting after the screen closes', async () => {
    let finishMint!: (link: string) => void;
    mockSharing.createPairInvite.mockReturnValueOnce(
      new Promise((resolve) => {
        finishMint = resolve;
      })
    );
    await act(async () => {
      renderer = create(<ActivePairingScreen />);
    });
    await act(async () => action('make a link').props.onPress());
    await act(async () => action('Close pairing').props.onPress());
    await act(async () => finishMint(LINK));

    expect(mockSharing.cancelPairInvite).toHaveBeenCalled();
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    expect(Share.share).not.toHaveBeenCalled();
  });
});
