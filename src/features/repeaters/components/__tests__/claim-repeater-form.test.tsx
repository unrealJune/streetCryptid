import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Switch, Text } from 'react-native';

import { ClaimRepeaterForm } from '../claim-repeater-form';

jest.mock('@/global.css', () => ({}));

const LINK = `streetcryptid-repeater:endpointabc#${'ab'.repeat(32)}`;

jest.mock('expo-clipboard', () => ({
  getStringAsync: jest.fn(() =>
    Promise.resolve(`  ${'streetcryptid-repeater:endpointabc#' + 'ab'.repeat(32)}\n`)
  ),
}));

describe('ClaimRepeaterForm', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  function render(onClaim: jest.Mock, firstRepeater = true) {
    act(() => {
      renderer = create(
        <ClaimRepeaterForm
          accent="#0f0"
          warning="#fa0"
          firstRepeater={firstRepeater}
          onClaim={onClaim}
        />
      );
    });
  }

  const press = (label: string) =>
    act(async () => {
      renderer.root.findByProps({ accessibilityLabel: label }).props.onPress();
    });

  const texts = () => renderer.root.findAllByType(Text).map((node) => String(node.props.children));

  it('refuses a malformed link without dialling', async () => {
    const onClaim = jest.fn();
    render(onClaim);
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Repeater claim link' })
        .props.onChangeText('streetcryptid-repeater:endpointabc');
    });
    await press('Claim the repeater');
    expect(onClaim).not.toHaveBeenCalled();
    expect(texts()).toContain('That link is cut short. Copy the whole line from the console.');
  });

  it('pastes, then claims invite-only and carrying me by default', async () => {
    const onClaim = jest.fn(() => Promise.resolve(null));
    render(onClaim);
    await press('Paste the claim link');
    await press('Claim the repeater');
    expect(onClaim).toHaveBeenCalledWith(LINK, false, true);
    expect(texts()).toContain('Claimed. It is listed in your roster.');
  });

  it('says why a claim failed', async () => {
    const onClaim = jest.fn(() => Promise.resolve('Someone has already claimed this repeater.'));
    render(onClaim);
    await press('Paste the claim link');
    await press('Claim the repeater');
    expect(texts()).toContain('Someone has already claimed this repeater.');
  });

  it('offers a policy only for the machine that starts the roster', () => {
    render(jest.fn(), false);
    const switches = renderer.root.findAllByType(Switch).map((s) => s.props.accessibilityLabel);
    expect(switches).toEqual(['Carry my trail on the new repeater']);
  });
});
