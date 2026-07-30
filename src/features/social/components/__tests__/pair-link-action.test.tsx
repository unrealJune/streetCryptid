import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Platform, Share } from 'react-native';

import type { PairingSnapshot } from '../../net/location-sharing';
import { PairLinkAction } from '../pair-link-action';

jest.mock('@/global.css', () => ({}));

const LINK = 'streetcryptid:///social?token=scpair1%3Aabcdef';

const PAIRING: PairingSnapshot = {
  available: true,
  ready: true,
  capabilities: null,
  nearbyPeers: [],
  sessions: [],
  pendingRequests: [],
  verifications: [],
  bump: { active: false, phase: 'idle', peers: [], since: null },
  discoveredFriend: null,
  inviteLink: null,
  activity: '',
} as unknown as PairingSnapshot;

function shareButton(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) =>
      node.props?.accessibilityLabel === 'Share a one-time pairing link' &&
      typeof node.props?.onPress === 'function'
  )[0];
}

describe('PairLinkAction share', () => {
  let renderer: ReactTestRenderer;
  const originalOS = Platform.OS;

  afterEach(() => {
    act(() => renderer?.unmount());
    Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
    jest.restoreAllMocks();
  });

  const shareOnce = async (os: 'ios' | 'android') => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    const share = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction', activityType: null });
    act(() => {
      renderer = create(
        <PairLinkAction
          pairing={PAIRING}
          accent="#2f9e6a"
          errorAccent="#d94f4f"
          onCreateInvite={() => Promise.resolve(LINK)}
          onPairInput={() => Promise.resolve()}
          onReject={() => Promise.resolve()}
        />
      );
    });
    await act(async () => {
      await shareButton(renderer).props.onPress();
    });
    return share.mock.calls[0]?.[0];
  };

  it('shares the link exactly once on iOS', async () => {
    const content = await shareOnce('ios');
    expect(content).toEqual({ url: LINK });
    expect(content?.message).toBeUndefined();
  });

  it('shares the link exactly once on Android', async () => {
    const content = await shareOnce('android');
    expect(content?.message).toBe(LINK);
    expect(content?.title).not.toContain(LINK);
  });
});
