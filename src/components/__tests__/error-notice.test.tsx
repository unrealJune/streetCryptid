import * as Clipboard from 'expo-clipboard';
import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ErrorNotice } from '../error-notice';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

const texts = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByType(Text).map((node) => node.props.children);

describe('ErrorNotice', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  it('copies the message on tap and confirms', async () => {
    act(() => {
      renderer = create(<ErrorNotice accent="#f0a" title="Sync failed" message="socket closed" />);
    });

    await act(async () => {
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Sync failed\nsocket closed');
    expect(texts(renderer)).toContain('COPIED');
  });

  it('copies the override text when provided', async () => {
    act(() => {
      renderer = create(
        <ErrorNotice
          accent="#f0a"
          title="Location access is off"
          message="Allow background location."
          copyText="raw failure detail"
        />
      );
    });

    await act(async () => {
      renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('raw failure detail');
  });
});
