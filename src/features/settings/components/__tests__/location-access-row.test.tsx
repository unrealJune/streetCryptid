import { Linking } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { LocationAccessRow } from '../location-access-row';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-symbols', () => ({ SymbolView: () => null }));

describe('LocationAccessRow', () => {
  let renderer: ReactTestRenderer;
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  it('opens OS settings through an accessible icon rather than a Review text button', () => {
    const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    act(() => {
      renderer = create(<LocationAccessRow accent="#0f0" status="accepted" onTurnOn={jest.fn()} />);
    });
    const action = renderer.root.findByProps({ accessibilityLabel: 'Review location permissions' });
    act(() => action.props.onPress());
    expect(open).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('Review Permissions in settings');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('"REVIEW"');
  });

  it('retains the disclosure flow when background location was declined', () => {
    const onTurnOn = jest.fn();
    act(() => {
      renderer = create(<LocationAccessRow accent="#0f0" status="declined" onTurnOn={onTurnOn} />);
    });
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: 'Turn on background location' })
        .props.onPress()
    );
    expect(onTurnOn).toHaveBeenCalledTimes(1);
  });
});
