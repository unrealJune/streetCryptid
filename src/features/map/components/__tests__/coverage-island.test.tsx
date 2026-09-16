import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { CoverageIsland } from '../coverage-island';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));

/**
 * `minimized` is the drawer's `collapsed` detent, reached by its grip — the body has no collapse
 * control of its own any more, so these render the two states directly rather than pressing one.
 */
function island(props: { minimized: boolean; sectorsVisible: boolean; coverage: number }) {
  return (
    <CoverageIsland
      coverage={props.coverage}
      minimized={props.minimized}
      placeName="Capitol Hill"
      sectorsVisible={props.sectorsVisible}
      signal="#2F9E6A"
      theme={CryptidThemes.daybreak}
    />
  );
}

describe('CoverageIsland', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('shows the full readout expanded and the place-plus-percent line collapsed', () => {
    act(() => {
      renderer = create(island({ minimized: false, sectorsVisible: true, coverage: 0.42 }));
    });

    expect(findText(renderer, 'PERCENT EXPLORED')).toHaveLength(1);
    expect(findText(renderer, 'Capitol Hill')).toHaveLength(1);

    act(() => {
      renderer.update(island({ minimized: true, sectorsVisible: true, coverage: 0.42 }));
    });

    // Collapsed is the same single line the roster collapses to: the hero and one number.
    expect(findText(renderer, 'PERCENT EXPLORED')).toHaveLength(0);
    expect(findText(renderer, 'Capitol Hill')).toHaveLength(1);
    expect(findText(renderer, '42%')).toHaveLength(1);
  });

  it('carries no collapse control of its own — the drawer owns that', () => {
    act(() => {
      renderer = create(island({ minimized: false, sectorsVisible: true, coverage: 0.42 }));
    });

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Minimize location summary' })
    ).toHaveLength(0);
  });

  it('hides the sector readout below the exploration render cutoff', () => {
    act(() => {
      renderer = create(island({ minimized: false, sectorsVisible: false, coverage: 0 }));
    });

    // No readout and no misleading 0% — just the place name.
    expect(findText(renderer, 'PERCENT EXPLORED')).toHaveLength(0);
    expect(findText(renderer, '0%')).toHaveLength(0);
    expect(findText(renderer, 'Capitol Hill')).toHaveLength(1);
  });

  it('does not take the collapsed detent’s shape just because the sectors are hidden', () => {
    // The cutoff is not the collapsed detent — it takes `collapsed` AWAY, so the drawer has one
    // stop and renders no grip. Borrowing the collapsed body reserved 16pt for a handle that was
    // not there, and the place name sat hard against the top of the island.
    act(() => {
      renderer = create(island({ minimized: false, sectorsVisible: false, coverage: 0 }));
    });
    const atCutoff = renderer.root.findByProps({ testID: 'coverage-island-body' }).props.style;

    act(() => {
      renderer.update(island({ minimized: true, sectorsVisible: true, coverage: 0.42 }));
    });
    const collapsed = renderer.root.findByProps({ testID: 'coverage-island-body' }).props.style;

    expect(atCutoff).not.toEqual(collapsed);
    // …and it is the same shape the expanded body uses, so the row sits in balanced padding.
    act(() => {
      renderer.update(island({ minimized: false, sectorsVisible: true, coverage: 0.42 }));
    });
    expect(atCutoff).toEqual(
      renderer.root.findByProps({ testID: 'coverage-island-body' }).props.style
    );
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
