import { AppState } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { PairingSnapshot } from '../../net/location-sharing';
import { BUMP_FOREGROUND_GRACE_MS, useArmedBump } from '../use-armed-bump';

jest.mock('expo-sensors', () => ({
  Accelerometer: {
    isAvailableAsync: jest.fn(async () => false),
    setUpdateInterval: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

const mockArmBump = jest.fn(async () => {});
const mockCancelBump = jest.fn(async () => {});
const mockCommitBump = jest.fn(async () => {});
const mockRefreshPairing = jest.fn(async () => {});
let mockPairing: PairingSnapshot | null = null;

jest.mock('../use-location-sharing', () => ({
  useLocationSharing: () => ({
    pairing: mockPairing,
    armBump: mockArmBump,
    commitBump: mockCommitBump,
    cancelBump: mockCancelBump,
    refreshPairing: mockRefreshPairing,
  }),
}));

/** The parts of the snapshot `useArmedBump` actually reads. */
function snapshot(overrides: Partial<PairingSnapshot> = {}): PairingSnapshot {
  return {
    available: true,
    ready: false,
    capabilities: null,
    radio: 'poweredOn',
    nearbyPeers: [],
    sessions: [],
    pendingRequests: [],
    verifications: [],
    bump: { stage: 'idle', expiresAt: null, rssi: null, peerCount: 0, error: null },
    discoveredFriend: null,
    inviteLink: null,
    inviteExpiresAt: null,
    inviteRedeemed: false,
    inviteCode: null,
    failure: null,
    mailboxAvailable: false,
    activity: '',
    ...overrides,
  } as PairingSnapshot;
}

function Harness({ active }: { readonly active: boolean }) {
  useArmedBump(active);
  return null;
}

describe('useArmedBump', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPairing = null;
    // The hook only holds the radio open for a FOREGROUND surface, and jest's AppState does not
    // start there. Without this the arming assertions below would all pass for the wrong reason.
    (AppState as unknown as { currentState: string }).currentState = 'active';
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.useRealTimers();
  });

  it('arms once the surface is live and nothing else is in flight', () => {
    jest.useFakeTimers();
    mockPairing = snapshot();
    act(() => {
      renderer = create(<Harness active />);
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(mockArmBump).toHaveBeenCalled();
  });

  it('does not arm while a discovered friend is on screen', () => {
    jest.useFakeTimers();
    mockPairing = snapshot({ discoveredFriend: { endpointId: 'aabb' } as never });
    act(() => {
      renderer = create(<Harness active />);
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(mockArmBump).not.toHaveBeenCalled();
  });

  // Regression, 2026-09-13: ACKNOWLEDGE re-opened the Bluetooth pairing radio on its way out.
  // Clearing the discovered friend is exactly what makes this hook think it may arm again, so a
  // dismissal that cleared the friend WITHOUT first dropping `active` got `pairing_ready` true at
  // 21:51:43 and false at 21:51:45 — a radio armed for a screen the user had already left, and
  // closed only because `cancelBump` happened to win the race.
  it('does not arm when the friend is cleared by the same dismissal that closes the screen', () => {
    jest.useFakeTimers();
    mockPairing = snapshot({ discoveredFriend: { endpointId: 'aabb' } as never });
    act(() => {
      renderer = create(<Harness active />);
    });
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockArmBump).not.toHaveBeenCalled();

    // What ACKNOWLEDGE does: the friend goes away and the surface stops being live together.
    mockPairing = snapshot();
    act(() => {
      renderer.update(<Harness active={false} />);
    });
    act(() => {
      jest.advanceTimersByTime(50);
    });

    expect(mockArmBump).not.toHaveBeenCalled();
  });

  describe('closing the window', () => {
    let emitAppState: (state: string) => void = () => {};

    beforeEach(() => {
      jest
        .spyOn(AppState, 'addEventListener')
        .mockImplementation((_type: string, listener: (state: never) => void) => {
          emitAppState = (state) => listener(state as never);
          return { remove: jest.fn() } as never;
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function armedAndMounted(): void {
      jest.useFakeTimers();
      mockPairing = snapshot({
        bump: { stage: 'armed', expiresAt: null, rssi: null, peerCount: 0, error: null },
      } as never);
      act(() => {
        renderer = create(<Harness active />);
      });
    }

    // 2026-10-31: a Pixel 10 left the foreground for 1.6 s mid-handshake and lost the window.
    it('keeps it open through a short trip out of the foreground', () => {
      armedAndMounted();
      act(() => emitAppState('background'));
      act(() => {
        jest.advanceTimersByTime(2_000);
      });
      act(() => emitAppState('active'));
      act(() => {
        jest.advanceTimersByTime(BUMP_FOREGROUND_GRACE_MS * 2);
      });

      expect(mockCancelBump).not.toHaveBeenCalled();
    });

    it('closes it once the app has been away longer than the grace', () => {
      armedAndMounted();
      act(() => emitAppState('background'));
      act(() => {
        jest.advanceTimersByTime(BUMP_FOREGROUND_GRACE_MS + 1);
      });

      expect(mockCancelBump).toHaveBeenCalled();
    });

    it('closes it at once when the screen is left', () => {
      armedAndMounted();
      act(() => {
        renderer.update(<Harness active={false} />);
      });

      expect(mockCancelBump).toHaveBeenCalled();
    });
  });
});
