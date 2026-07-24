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
        <CoverageIsland
          theme={CryptidThemes.daybreak}
          placeName="Capitol Hill"
          coverage={0.42}
          sectorsVisible
        />
      );
    });

    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(1);

    const minimizeButton = renderer.root.findByProps({
      accessibilityLabel: 'Minimize location summary',
    });
    expect(minimizeButton.props.accessibilityState).toEqual({ expanded: true });

    act(() => minimizeButton.props.onPress());

    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(0);
    expect(findText(renderer, '42%')).toHaveLength(1);

    const expandButton = renderer.root.findByProps({
      accessibilityLabel: 'Expand location summary',
    });
    expect(expandButton.props.accessibilityState).toEqual({ expanded: false });

    act(() => expandButton.props.onPress());

    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(1);
  });

  it('hides the sector readout below the exploration render cutoff', () => {
    act(() => {
      renderer = create(
        <CoverageIsland
          theme={CryptidThemes.daybreak}
          placeName="Capitol Hill"
          coverage={0}
          sectorsVisible={false}
        />
      );
    });

    // No readout, no misleading 0%, and no chevron to expand into nothing.
    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(0);
    expect(findText(renderer, '0%')).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Minimize location summary' })
    ).toHaveLength(0);
    // The place name still headlines the island.
    expect(findText(renderer, 'Capitol Hill')).toHaveLength(1);
  });

  it('restores the user’s own minimize choice when sectors come back', () => {
    act(() => {
      renderer = create(
        <CoverageIsland
          theme={CryptidThemes.daybreak}
          placeName="Capitol Hill"
          coverage={0.42}
          sectorsVisible
        />
      );
    });
    // User expands nothing — it starts expanded. Minimize it by hand.
    act(() =>
      renderer.root.findByProps({ accessibilityLabel: 'Minimize location summary' }).props.onPress()
    );
    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(0);

    // Zoom out past the cutoff and back in: still minimized, not re-expanded.
    act(() => {
      renderer.update(
        <CoverageIsland
          theme={CryptidThemes.daybreak}
          placeName="Capitol Hill"
          coverage={0}
          sectorsVisible={false}
        />
      );
    });
    act(() => {
      renderer.update(
        <CoverageIsland
          theme={CryptidThemes.daybreak}
          placeName="Capitol Hill"
          coverage={0.42}
          sectorsVisible
        />
      );
    });

    expect(findText(renderer, 'SECTORS IN VIEW')).toHaveLength(0);
    expect(findText(renderer, '42%')).toHaveLength(1);
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
