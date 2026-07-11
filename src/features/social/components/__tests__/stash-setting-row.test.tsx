import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Switch } from 'react-native';

import { StashSettingRow } from '../stash-setting-row';

jest.mock('@/global.css', () => ({}));

describe('StashSettingRow', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('reflects the opted-in state and reports toggles', () => {
    const onToggle = jest.fn();
    act(() => {
      renderer = create(<StashSettingRow accent="#2f9e6a" optedIn={false} onToggle={onToggle} />);
    });

    const toggle = renderer.root.findByType(Switch);
    expect(toggle.props.value).toBe(false);

    act(() => toggle.props.onValueChange(true));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
