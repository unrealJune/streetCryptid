import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidAvatar } from '../cryptid-avatar';

jest.mock('@/global.css', () => ({}));

describe('CryptidAvatar', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it.each([undefined, true, false])(
    'preserves art and accessibility when showLabel is %s',
    (showLabel) => {
      act(() => {
        renderer = create(
          <CryptidAvatar art="(o.o)" color="#FF0000" name="Lantern Owl" showLabel={showLabel} />
        );
      });

      const texts = renderer.root.findAllByType(Text);
      expect(texts.filter((node) => node.props.children === 'LANTERN OWL')).toHaveLength(
        showLabel === false ? 0 : 1
      );
      expect(
        texts.some((node) => node.props.children === '(o.o)' && node.props.accessible !== false)
      ).toBe(true);
      expect(
        renderer.root.findByProps({ accessibilityLabel: 'Lantern Owl ASCII cryptid' })
      ).toBeTruthy();
    }
  );
});
