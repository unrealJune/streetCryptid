import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { CoverageIsland } from '../coverage-island';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

describe('CoverageIsland', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('toggles between the detailed and compact location summaries', () => {
    act(() => {
      renderer = create(
        <CoverageIsland theme={CryptidThemes.daybreak} placeName="Capitol Hill" coverage={0.42} />
      );
    });

    expect(findText(renderer, 'SECTORS IN VIEW · © OPENSTREETMAP')).toHaveLength(1);

    const minimizeButton = renderer.root.findByProps({
      accessibilityLabel: 'Minimize location summary',
    });
    expect(minimizeButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => minimizeButton.props.onPress());

    expect(findText(renderer, 'SECTORS IN VIEW · © OPENSTREETMAP')).toHaveLength(0);
    expect(findText(renderer, '42%')).toHaveLength(1);

    const expandButton = renderer.root.findByProps({
      accessibilityLabel: 'Expand location summary',
    });
    expect(expandButton.props.accessibilityState).toEqual({ expanded: false });

    act(() => expandButton.props.onPress());

    expect(findText(renderer, 'SECTORS IN VIEW · © OPENSTREETMAP')).toHaveLength(1);
  });
});

function findText(renderer: ReactTestRenderer, value: string) {
  return renderer.root.findAllByType(Text).filter((node) => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children.join('') === value;
  });
}
