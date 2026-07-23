import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, Switch, TextInput } from 'react-native';

import { DebugLocationControls } from '../debug-location-controls';

jest.mock('@/global.css', () => ({}));

describe('DebugLocationControls', () => {
  let renderer: ReactTestRenderer;
  let appStateListener: ((state: string) => void) | undefined;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListener = listener as (state: string) => void;
      return { remove: jest.fn() };
    });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('publishes immediately on demand', async () => {
    const onPush = jest.fn(async () => 7);
    await act(async () => {
      renderer = create(
        <DebugLocationControls accent="#2f9e6a" warningColor="#f2ad42" onPush={onPush} />
      );
    });

    await act(async () => {
      renderer.root.findByProps({ accessibilityLabel: 'Push location now' }).props.onPress();
    });

    expect(onPush).toHaveBeenCalledWith('manual');
  });

  it('publishes on the configured foreground schedule and pauses in background', async () => {
    const onPush = jest.fn(async () => 8);
    await act(async () => {
      renderer = create(
        <DebugLocationControls accent="#2f9e6a" warningColor="#f2ad42" onPush={onPush} />
      );
    });

    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('1');
      renderer.root.findByType(Switch).props.onValueChange(true);
    });
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(onPush).toHaveBeenCalledWith('scheduled');

    act(() => appStateListener?.('background'));
    await act(async () => {
      jest.advanceTimersByTime(2000);
    });
    expect(onPush).toHaveBeenCalledTimes(1);
  });

  it('supports intervals in minutes', async () => {
    const onPush = jest.fn(async () => 9);
    await act(async () => {
      renderer = create(
        <DebugLocationControls accent="#2f9e6a" warningColor="#f2ad42" onPush={onPush} />
      );
    });

    const minuteButton = renderer.root.findByProps({
      accessibilityLabel: 'Use minutes for the location push interval',
    });
    act(() => {
      renderer.root.findByType(TextInput).props.onChangeText('1');
      minuteButton.props.onPress();
      renderer.root.findByType(Switch).props.onValueChange(true);
    });
    await act(async () => {
      jest.advanceTimersByTime(59_000);
    });
    expect(onPush).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(onPush).toHaveBeenCalledWith('scheduled');
  });
});
