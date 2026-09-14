import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { IdentityRow } from '../identity-row';

jest.mock('@/global.css', () => ({}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/features/account/hooks/use-cryptid-profile', () => ({
  useCryptidProfile: () => ({
    profile: { handle: '@tallgrass', cryptidName: 'Jackalope', sigil: '(oo)', color: '#00FF00' },
  }),
}));

describe('Profile settings plate', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPush.mockClear();
  });

  it('shows you rather than the word for you', () => {
    act(() => {
      renderer = create(<IdentityRow accent="#0f0" />);
    });
    const text = renderer.root.findAllByType(Text).map((node) => node.props.children);

    // The plate is your cryptid, so it renders your cryptid: sigil, handle, name. The
    // literal word "Profile" is the accessibility label and nothing else — a settings
    // menu whose first entry reads "Profile ›" in the same weight as "App & Data ›" has
    // no focal point, which is the whole reason this stopped being a row.
    expect(text).toContain('@tallgrass');
    expect(text).toContain('(oo)');
    expect(text).toContain('JACKALOPE');
    expect(text).not.toContain('Profile');
    expect(text).not.toContain('This is the sigil and signal color your friends see.');

    const row = renderer.root.findByProps({ accessibilityLabel: 'Profile' });
    expect(row.props.accessibilityValue).toEqual({ text: '@tallgrass' });
    act(() => row.props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/settings/profile');
  });
});
