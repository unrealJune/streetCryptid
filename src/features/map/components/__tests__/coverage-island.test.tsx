import { Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CryptidThemes } from '@/constants/cryptid-theme';

import { CoverageIsland } from '../coverage-island';

jest.mock('expo-symbols', () => ({
  SymbolView: () => null,
}));
jest.mock('@/global.css', () => ({}));
jest.mock('react-native-reanimated', () => {
  const { Text, View } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: { Text, View },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    withTiming: (value: number) => value,
    interpolate: (value: number, input: number[], output: number[]) =>
      output[0] + ((value - input[0]) / (input[1] - input[0])) * (output[1] - output[0]),
  };
});

/**
 * The body no longer has a collapsed layout to switch to: it always lays out expanded and the
 * drawer's live height morphs it (`drawer-progress.ts`), so these cover what it SAYS rather than
 * which of two shapes it took.
 */
function island(props: { sectorsVisible: boolean; coverage: number }) {
  return (
    <CoverageIsland
      coverage={props.coverage}
      placeName="Mercer Island"
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

  it('shows the place, the readout and ONE visible percentage', () => {
    act(() => {
      renderer = create(island({ sectorsVisible: true, coverage: 0.01 }));
    });

    expect(findText(renderer, 'Mercer Island')).toHaveLength(1);
    expect(findText(renderer, 'PERCENT EXPLORED')).toHaveLength(1);
    // Two nodes — the floating number and the invisible copy holding its slot in the bar row —
    // but only one is ever seen. A second visible "1%" is what the swap used to flash.
    const pcts = findText(renderer, '1%');
    expect(pcts).toHaveLength(2);
    expect(pcts.filter((node) => !isInvisible(node.props.style))).toHaveLength(1);
  });

  it('carries no collapse control of its own — the drawer owns that', () => {
    act(() => {
      renderer = create(island({ sectorsVisible: true, coverage: 0.42 }));
    });

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Minimize location summary' })
    ).toHaveLength(0);
  });

  it('fades the percentage out once coverage is no longer measurable', () => {
    act(() => {
      renderer = create(island({ sectorsVisible: false, coverage: 0 }));
    });

    expect(isInvisible(floatingPct(renderer).props.style)).toBe(true);
    // Outside a drawer (the wide column) nothing folds the readout away, so it fades too.
    const readout = findText(renderer, 'PERCENT EXPLORED')[0].parent;
    expect(isInvisible(readout?.props.style)).toBe(true);
    expect(findText(renderer, 'Mercer Island')).toHaveLength(1);
    expect(
      renderer.root.findByProps({ accessibilityRole: 'summary' }).props.accessibilityLabel
    ).toBe('Mercer Island. Sector coverage is hidden at this zoom.');
  });

  it('keeps the number mounted, holding its last value, while the drawer is forced shut', () => {
    // Crossing the cutoff from `peek` springs the drawer closed at the same moment. The number
    // used to unmount on that first frame; it has to stay and fade as it rides up instead —
    // still reading its last real value, not the placeholder 0.
    act(() => {
      renderer = create(island({ sectorsVisible: true, coverage: 0.42 }));
    });
    expect(isInvisible(floatingPct(renderer).props.style)).toBe(false);
    act(() => {
      renderer.update(island({ sectorsVisible: false, coverage: 0 }));
    });
    // The mock's animated styles only re-read shared values on render; the real ones follow the
    // fade on the UI thread.
    act(() => {
      renderer.update(island({ sectorsVisible: false, coverage: 0 }));
    });

    expect(floatingPct(renderer).findByType(Text).props.children.join('')).toBe('42%');
    expect(isInvisible(floatingPct(renderer).props.style)).toBe(true);
    expect(findText(renderer, '0%')).toHaveLength(0);
  });
});

function floatingPct(renderer: ReactTestRenderer) {
  return renderer.root.findAll((node) => node.props.testID === 'coverage-island-pct')[0];
}

function isInvisible(style: unknown): boolean {
  const flat = (Array.isArray(style) ? style : [style]).flat(Infinity) as { opacity?: number }[];
  return flat.some((entry) => entry?.opacity === 0);
}

function findText(renderer: ReactTestRenderer, value: string) {
  return renderer.root.findAllByType(Text).filter((node) => {
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    return children.join('') === value;
  });
}
