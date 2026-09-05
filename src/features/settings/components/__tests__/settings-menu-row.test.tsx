import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SettingsMenuRow } from '../settings-menu-row';

jest.mock('@/global.css', () => ({}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe('SettingsMenuRow', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => mockPush.mockClear());
  afterEach(() => {
    act(() => renderer?.unmount());
  });

  function render(props: Partial<Parameters<typeof SettingsMenuRow>[0]> = {}) {
    act(() => {
      renderer = create(
        <SettingsMenuRow
          href="/settings/transports"
          label="Transports"
          detail="Which paths the node may use."
          {...props}
        />
      );
    });
    return renderer.root.findByProps({ accessibilityLabel: 'Transports' });
  }

  it('navigates to its page when tapped', () => {
    const pressable = render();

    act(() => pressable.props.onPress());
    expect(mockPush).toHaveBeenCalledWith('/settings/transports');
  });

  it('announces its current state so the menu is readable without opening it', () => {
    const pressable = render({ value: '2/3 on' });

    expect(pressable.props.accessibilityLabel).toBe('Transports');
    expect(pressable.props.accessibilityHint).toBe('Which paths the node may use.');
    expect(pressable.props.accessibilityValue).toEqual({ text: '2/3 on' });
  });

  it('omits the accessibility value when there is no state to summarise', () => {
    expect(render().props.accessibilityValue).toBeUndefined();
  });
});
