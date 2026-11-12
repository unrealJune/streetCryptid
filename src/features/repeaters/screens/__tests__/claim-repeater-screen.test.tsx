import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import ClaimRepeaterScreen from '../claim-repeater-screen';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(async () => `  streetcryptid-repeater:endpointabc#${'ab'.repeat(32)}\n`),
}));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('react-native-reanimated', () => {
  const { View } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => undefined },
    FadeOut: { duration: () => undefined },
    useReducedMotion: () => true,
  };
});
jest.mock('@/features/social/components/pressable-action', () => ({
  PressableAction: jest.requireActual('react-native').Pressable,
}));
jest.mock('@/features/social/components/pairing-signal-field', () => ({
  PairingSignalField: () => null,
}));
jest.mock('@/features/haptics/haptics', () => ({
  successHaptic: jest.fn(async () => {}),
  warningHaptic: jest.fn(async () => {}),
}));
const mockRouter = { back: jest.fn(), replace: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));
const mockRepeaters = {
  status: 'ready',
  sections: { mine: null, carryingMe: [], throughFriends: [], others: [] } as {
    mine: unknown;
  },
  claim: jest.fn(async (): Promise<string | null> => null),
};
jest.mock('../../hooks/use-repeaters', () => ({ useRepeaters: () => mockRepeaters }));

const LINK = `streetcryptid-repeater:endpointabc#${'ab'.repeat(32)}`;

describe('ClaimRepeaterScreen', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
    mockRepeaters.sections.mine = null;
  });

  const press = (label: string) =>
    act(async () => {
      renderer.root.findAllByProps({ accessibilityLabel: label })[0].props.onPress();
    });
  const text = () => JSON.stringify(renderer.toJSON());

  function render() {
    act(() => {
      renderer = create(<ClaimRepeaterScreen />);
    });
  }

  it('refuses a malformed link without dialling', async () => {
    render();
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Repeater claim link' })
        .props.onChangeText('streetcryptid-repeater:endpointabc');
    });
    await press('Use this claim link');
    expect(mockRepeaters.claim).not.toHaveBeenCalled();
    expect(text()).toContain('That link is cut short');
  });

  it('pastes, then claims invite-only and carrying me by default', async () => {
    render();
    await press('Paste the claim link');
    expect(text()).toContain('SCANNED');
    await press('Claim the repeater');
    expect(mockRepeaters.claim).toHaveBeenCalledWith(LINK, false, true);
    expect(text()).toContain('CERT CHECKED');
  });

  it('says why a claim was refused, and that nothing was added', async () => {
    mockRepeaters.claim.mockResolvedValueOnce('Someone has already claimed this repeater.');
    render();
    await press('Paste the claim link');
    await press('Claim the repeater');
    expect(text()).toContain('NOTHING WAS ADDED');
    expect(text()).toContain('Someone has already claimed this repeater.');
  });

  it('asks about the policy only for the machine that starts the roster', async () => {
    mockRepeaters.sections.mine = { rosterId: 'r' };
    render();
    await press('Paste the claim link');
    expect(renderer.root.findAllByProps({ accessibilityLabel: 'Open to anyone' })).toHaveLength(0);
  });
});
