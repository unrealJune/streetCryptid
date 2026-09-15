import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AccountOnboardingScreen } from '../../screens/account-onboarding-screen';
import { CryptidAccountGate } from '../cryptid-account-gate';

jest.mock('@/global.css', () => ({}));
jest.mock('../../screens/account-onboarding-screen', () => ({
  AccountOnboardingScreen: () => null,
}));
const mockContext: { status: 'ready' | 'loading'; profile: object | null } = {
  status: 'ready',
  profile: null,
};
jest.mock('../../hooks/use-cryptid-profile', () => ({ useCryptidProfile: () => mockContext }));

describe('CryptidAccountGate', () => {
  let renderer: ReactTestRenderer;
  const content = (
    <CryptidAccountGate>
      <Text>Map</Text>
    </CryptidAccountGate>
  );

  afterEach(() => {
    act(() => renderer?.unmount());
    mockContext.profile = null;
    mockContext.status = 'ready';
  });

  it('does not send existing profiles back through new-user delivery setup', () => {
    mockContext.profile = { handle: '@existing' };
    act(() => {
      renderer = create(content);
    });
    expect(renderer.root.findAllByType(AccountOnboardingScreen)).toHaveLength(0);
    expect(renderer.root.findByType(Text).props.children).toBe('Map');
  });

  it('holds onboarding while the final profile write updates context', () => {
    act(() => {
      renderer = create(content);
    });
    act(() => renderer.root.findByType(AccountOnboardingScreen).props.onSaveStart());
    mockContext.profile = { handle: '@new' };
    act(() =>
      renderer.update(
        <CryptidAccountGate>
          <Text>Map</Text>
        </CryptidAccountGate>
      )
    );
    expect(renderer.root.findAllByType(AccountOnboardingScreen)).toHaveLength(1);
    act(() => renderer.root.findByType(AccountOnboardingScreen).props.onComplete());
    expect(renderer.root.findByType(Text).props.children).toBe('Map');
  });
});
