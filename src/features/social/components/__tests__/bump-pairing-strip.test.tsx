import { Platform, Text } from 'react-native';
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
    radio: 'poweredOn',
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
  const platform = Platform.OS;

  afterEach(() => {
    Platform.OS = platform;
  });

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(pairing: PairingSnapshot | null, handlers = {}) {
    const onCommit = jest.fn().mockResolvedValue(undefined);
    const onArm = jest.fn().mockResolvedValue(undefined);
    const onEnableBluetooth = jest.fn().mockResolvedValue(undefined);
    act(() => {
      renderer = create(
        <BumpPairingStrip
          onArm={onArm}
          onCommit={onCommit}
          onEnableBluetooth={onEnableBluetooth}
          pairing={pairing}
          sensor={sensor}
          theme={CryptidThemes.daybreak}
          {...handlers}
        />
      );
    });
    return { onCommit, onArm, onEnableBluetooth };
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

  // A dark radio used to arm happily and then resolve nothing: the strip said "READY FOR IMPACT"
  // while no scan could ever succeed. Naming the switch is the whole fix.
  it('names the radio switch instead of arming into a dark radio (Android)', async () => {
    Platform.OS = 'android';
    const { onEnableBluetooth, onArm } = render(snapshot({ radio: 'poweredOff' }));

    expect(text(renderer)).toContain('BLUETOOTH IS OFF');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Open Bluetooth settings to turn the radio on',
    });
    await act(async () => {
      button.props.onPress();
    });
    expect(onEnableBluetooth).toHaveBeenCalledTimes(1);
    expect(onArm).not.toHaveBeenCalled();
  });

  // iOS has no public deep link to the Bluetooth toggle, so the control is greyed rather than
  // sending the user somewhere that cannot turn the radio on.
  it('greys the arm control on iOS when the radio is off', () => {
    Platform.OS = 'ios';
    render(snapshot({ radio: 'poweredOff' }));

    expect(text(renderer)).toContain('BLUETOOTH IS OFF');
    const button = renderer.root.findByProps({
      accessibilityLabel: 'Arm bump to meet a nearby friend',
    });
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });

  it('drops the control entirely when the device has no BLE radio at all', () => {
    render(snapshot({ radio: 'unsupported' }));

    expect(text(renderer)).toContain('NO BLUETOOTH RADIO');
    expect(renderer.root.findAllByProps({ accessibilityRole: 'button' })).toHaveLength(0);
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
