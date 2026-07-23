import * as Clipboard from 'expo-clipboard';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { AuthorIdRow } from '../author-id-row';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve()),
}));

describe('AuthorIdRow', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  it('shows and copies the author ID', async () => {
    act(() => {
      renderer = create(<AuthorIdRow authorId="author-123" />);
    });

    const text = renderer.root.findAllByType(Text).map((node) => node.props.children);
    expect(text).toEqual(expect.arrayContaining(['Author ID', 'author-123', 'Copy']));

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Copy author ID' }).props.onPress();
    });

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('author-123');
    expect(renderer.root.findAllByType(Text).map((node) => node.props.children)).toContain(
      'Copied'
    );
  });

  it('disables copying while the author ID is unavailable', () => {
    act(() => {
      renderer = create(<AuthorIdRow authorId={null} />);
    });

    expect(renderer.root.findByProps({ accessibilityLabel: 'Copy author ID' }).props.disabled).toBe(
      true
    );
    expect(renderer.root.findAllByType(Text).map((node) => node.props.children)).toContain(
      'Unavailable'
    );
  });
});
