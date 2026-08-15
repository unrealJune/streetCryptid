import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { BUILT_IN_MAP_COLOR_SCHEMES } from '@/features/map/theme/map-color-schemes';

import { MapColorSchemeRow } from '../map-color-scheme-row';

const mockSelect = jest.fn();
const mockSaveCustom = jest.fn();

jest.mock('@/global.css', () => ({}));
jest.mock('@/features/map/hooks/use-map-color-scheme', () => ({
  useMapColorScheme: () => ({
    customJson: '{}',
    saveCustom: mockSaveCustom,
    schemes: jest.requireActual('@/features/map/theme/map-color-schemes')
      .BUILT_IN_MAP_COLOR_SCHEMES,
    select: mockSelect,
    selectedId: 'neon-grid',
  }),
}));

describe('MapColorSchemeRow', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
  });

  function render() {
    act(() => {
      renderer = create(<MapColorSchemeRow />);
    });
    return renderer.root.findAll((node) => node.props.accessibilityRole === 'radio', {
      deep: false,
    });
  }

  it('offers every built-in scheme and marks the active one', () => {
    const options = render();

    expect(options).toHaveLength(BUILT_IN_MAP_COLOR_SCHEMES.length);
    expect(
      options.find((option) => option.props.accessibilityState.selected)?.props.accessibilityLabel
    ).toBe('Neon Grid map colors');
  });

  it('selects a scheme from settings', () => {
    const options = render();
    const sunset = options.find(
      (option) => option.props.accessibilityLabel === 'Sunset map colors'
    );

    act(() => sunset?.props.onPress());

    expect(mockSelect).toHaveBeenCalledWith('sunset');
  });

  it('opens the custom palette importer', () => {
    render();
    const importButton = renderer.root.findByProps({
      accessibilityLabel: 'Import custom map palette',
    });

    act(() => importButton.props.onPress());

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Custom map palette JSON' })
    ).toBeTruthy();
  });
});
