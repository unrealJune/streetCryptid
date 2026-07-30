import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { BumpPairingStrip } from '../bump-pairing-strip';
import type { BumpSensorState } from '../../hooks/use-bump-to-pair';
import type { PairingSnapshot } from '../../net/location-sharing';

jest.mock('expo-symbols', () => ({ SymbolView: () => null }));
jest.mock('@/global.css', () => ({}));

const sensor: BumpSensorState = {
  status: 'ready',
  lastDetectedAt: null,
  lastIntensity: 0,
  error: null,
};

const capable = {
  available: true,
  activeScanToggle: true,
  rssi: true,
  discoveryRefresh: true,
  pairingReady: true,
};

function snapshot(overrides: Partial<PairingSnapshot> = {}): PairingSnapshot {
  return {
    available: true,
    ready: true,
    capabilities: capable,
    nearbyPeers: [],
    sessions: [],
    pendingRequests: [],
    verifications: [],
    bump: { stage: 'idle', expiresAt: null, rssi: null, peerCount: 0, error: null },
    discoveredFriend: null,
    inviteLink: null,
    inviteCode: null,
    mailboxAvailable: false,
    activity: '',
    ...overrides,
  };
}

describe('BumpPairingStrip', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(pairing: PairingSnapshot | null, handlers = {}) {
    const onCommit = jest.fn().mockResolvedValue(undefined);
    const onArm = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(
        <BumpPairingStrip
          onArm={onArm}
          onCommit={onCommit}
          pairing={pairing}
          sensor={sensor}
          theme={CryptidThemes.daybreak}
          {...handlers}
        />
      );
    });
    return { onCommit, onArm };
  }

  it('says why pairing is impossible in Expo Go rather than offering a dead button', () => {
    render(snapshot({ available: false }));

    expect(text(renderer)).toContain('PAIRING NEEDS AN INSTALLED BUILD');
    expect(renderer.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
  });

  // Arming is what requests Bluetooth permission, so the button has to survive the state that
  // ungranted permission produces — otherwise a phone that was never asked can never be asked.
  it('keeps an arm control when Bluetooth reports unavailable, since arming is what asks for it', async () => {
    const { onArm } = render(
      snapshot({
        capabilities: { ...capable, available: false },
      })
    );

    expect(text(renderer)).toContain('BLUETOOTH UNAVAILABLE');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Arm bump to meet a nearby friend',
    });

    await act(async () => {
      button.props.onPress();
    });
    expect(onArm).toHaveBeenCalledTimes(1);
  });

  it('offers a manual bump only once the radio is armed', async () => {
    const { onCommit } = render(
      snapshot({
        bump: { stage: 'armed', expiresAt: null, rssi: null, peerCount: 0, error: null },
      })
    );

    expect(text(renderer)).toContain('READY FOR IMPACT');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Pair with the phone touching this one',
    });
    await act(async () => {
      button.props.onPress();
    });
    expect(onCommit).toHaveBeenCalled();
  });

  it('parks on a retry after a miss instead of silently re-arming', async () => {
    const { onArm } = render(
      snapshot({
        bump: {
          stage: 'failed',
          expiresAt: null,
          rssi: null,
          peerCount: 0,
          error: 'No phone answered.',
        },
      })
    );

    expect(text(renderer)).toContain('BUMP MISSED');
    expect(text(renderer)).toContain('No phone answered.');
    const button = renderer.root.findByProps({ accessibilityLabel: 'Try bump again' });
    await act(async () => {
      button.props.onPress();
    });
    expect(onArm).toHaveBeenCalled();
  });

  it('offers a way in from idle, because idle is where a failed arm lands you', async () => {
    const { onArm } = render(snapshot());

    expect(text(renderer)).toContain('BUMP IS OFF');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Arm bump to meet a nearby friend',
    });
    await act(async () => {
      button.props.onPress();
    });
    expect(onArm).toHaveBeenCalled();
  });

  it('shows why arming failed rather than pretending it is still arming', () => {
    render(snapshot(), { error: 'Bluetooth permission was declined.' });

    expect(text(renderer)).toContain('BUMP DID NOT START');
    expect(text(renderer)).toContain('Bluetooth permission was declined.');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Try bump again' })).not.toHaveLength(
      0
    );
  });
});

function text(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType(Text).map((node) => String(node.props.children));
}
