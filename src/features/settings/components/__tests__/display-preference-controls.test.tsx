import { Switch } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DistanceUnitsRow } from '../distance-units-row';
import { FriendConnectionDetailsRow } from '../friend-connection-details-row';

jest.mock('@/global.css', () => ({}));
const mockSelectUnit = jest.fn();
const mockShowDetails = jest.fn();
const mockReload = jest.fn().mockResolvedValue(undefined);
const mockPreferences = {
  distanceUnit: 'km',
  showFriendConnectionDetails: false,
  ready: true,
  error: null as string | null,
};
jest.mock('../../hooks/use-display-preferences', () => ({
  useDisplayPreferences: () => ({
    ...mockPreferences,
    setDistanceUnit: mockSelectUnit,
    setShowFriendConnectionDetails: mockShowDetails,
    reload: mockReload,
  }),
}));

describe('display preference controls', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.clearAllMocks();
    mockPreferences.ready = true;
    mockPreferences.distanceUnit = 'km';
    mockPreferences.showFriendConnectionDetails = false;
    mockPreferences.error = null;
  });

  it('shows the metric default and saves an imperial selection', () => {
    act(() => {
      renderer = create(<DistanceUnitsRow />);
    });
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Kilometers' }).props.accessibilityState
        .selected
    ).toBe(true);
    act(() => renderer.root.findByProps({ accessibilityLabel: 'Miles' }).props.onPress());
    expect(mockSelectUnit).toHaveBeenCalledWith('mi');
  });

  it('starts friend diagnostics off and saves the toggle', () => {
    act(() => {
      renderer = create(<FriendConnectionDetailsRow accent="#0f0" />);
    });
    const control = renderer.root.findByType(Switch);
    expect(control.props.value).toBe(false);
    expect(control.props.accessibilityLabel).toBe('Show friend connection details');
    act(() => control.props.onValueChange(true));
    expect(mockShowDetails).toHaveBeenCalledWith(true);
  });

  it('does not show a selected distance unit until preferences have loaded', () => {
    mockPreferences.ready = false;
    act(() => {
      renderer = create(<DistanceUnitsRow />);
    });
    expect(renderer.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(0);
    mockPreferences.ready = true;
    mockPreferences.distanceUnit = 'mi';
    act(() => renderer.update(<DistanceUnitsRow />));
    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Miles' }).props.accessibilityState.selected
    ).toBe(true);
  });

  it('does not show a transient off switch while the saved diagnostics choice is loading', () => {
    mockPreferences.ready = false;
    act(() => {
      renderer = create(<FriendConnectionDetailsRow accent="#0f0" />);
    });
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    mockPreferences.ready = true;
    mockPreferences.showFriendConnectionDetails = true;
    act(() => renderer.update(<FriendConnectionDetailsRow accent="#0f0" />));
    expect(renderer.root.findByType(Switch).props.value).toBe(true);
  });

  it('offers retry after a read failure instead of displaying defaults', () => {
    mockPreferences.ready = false;
    mockPreferences.error = 'Could not load display preferences.';
    act(() => {
      renderer = create(<DistanceUnitsRow />);
    });
    expect(renderer.root.findAllByProps({ accessibilityRole: 'radio' })).toHaveLength(0);
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: 'Retry loading display preferences' })
        .props.onPress()
    );
    expect(mockReload).toHaveBeenCalledTimes(1);
  });
});
