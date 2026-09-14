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

describe('Profile settings row', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    mockPush.mockClear();
  });

  it('names the page first and the username second, without a cryptid title or subtitle', () => {
    act(() => {
      renderer = create(<IdentityRow accent="#0f0" />);
    });
    const text = renderer.root.findAllByType(Text).map((node) => node.props.children);
    expect(text.indexOf('Profile')).toBeLessThan(text.indexOf('(oo)'));
    expect(text.indexOf('Profile')).toBeLessThan(text.indexOf('@tallgrass'));
    expect(text).not.toContain('JACKALOPE');
    expect(text).not.toContain('This is the sigil and signal color your friends see.');
    const row = renderer.root.findByProps({ accessibilityLabel: 'Profile' });
    expect(row.props.accessibilityValue).toEqual({ text: '@tallgrass' });
    act(() => row.props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/settings/profile');
  });
});
