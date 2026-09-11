import { Pressable, Text } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { PairingFigureChoices, PairingFigureView } from '../../components/pairing-figure-view';
import { pairingFigure } from '../../core/pairing-figures';
import type { PairingVerification } from '../../net/location-sharing';
import { usePairingVerification } from '../use-pairing-verification';

jest.mock('@/global.css', () => ({}));
jest.mock('react-native-reanimated', () => {
  const { View, Text: RNText } = jest.requireActual('react-native');
  const { useRef } = jest.requireActual('react');
  return {
    __esModule: true,
    default: {
      View,
      Text: RNText,
      createAnimatedComponent: (component: unknown) => component,
    },
    useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => object) => factory(),
    useReducedMotion: () => false,
    withTiming: (value: number) => value,
  };
});
jest.mock('@/features/haptics/haptics', () => ({
  selectionHaptic: jest.fn(async () => {}),
  successHaptic: jest.fn(async () => {}),
  warningHaptic: jest.fn(async () => {}),
  transientHaptic: jest.fn(async () => {}),
}));
const mockHaptics = jest.requireMock('@/features/haptics/haptics') as {
  selectionHaptic: jest.Mock;
  successHaptic: jest.Mock;
  warningHaptic: jest.Mock;
  transientHaptic: jest.Mock;
};

beforeEach(() => {
  for (const fn of Object.values(mockHaptics)) fn.mockClear();
});

function verification(overrides: Partial<PairingVerification> = {}): PairingVerification {
  return {
    sessionId: 'session-1',
    peerEndpointId: 'peer-1',
    nearby: true,
    role: 'picker',
    targetIndex: 42,
    optionIndices: [12, 42, 116, 208],
    deadlineMs: Date.now() + 60_000,
    localConfirmed: false,
    peerVerified: true,
    ...overrides,
  };
}

interface HarnessProps {
  verifications: readonly PairingVerification[];
  onChoose?(sessionId: string, figureIndex: number): Promise<void>;
  onConfirm?(sessionId: string, matched: boolean): Promise<void>;
  onCancel?(sessionId: string): Promise<void>;
}

/**
 * The screen's two-zone composition in miniature: figures in the stage, prompt and buttons in
 * the panel, both driven by one hook. Testing the composition rather than a single component is
 * the point — the invariant worth protecting is that the panel never offers an action the stage
 * has refused to draw a challenge for.
 */
function Harness({ verifications, onChoose, onConfirm, onCancel }: HarnessProps) {
  const verify = usePairingVerification(verifications, {
    onChoose: onChoose ?? (async () => {}),
    onConfirm: onConfirm ?? (async () => {}),
    onCancel: onCancel ?? (async () => {}),
  });

  return (
    <>
      {verify.mode === 'pick' ? (
        <PairingFigureChoices
          accent="#2f9e6a"
          borderColor="#d6dee4"
          disabled={verify.disabled}
          onChoose={verify.choose}
          options={verify.options}
        />
      ) : verify.target && (verify.mode === 'show' || verify.mode === 'waiting') ? (
        <PairingFigureView accent="#2f9e6a" figure={verify.target} large />
      ) : null}
      {verify.mode === 'show' ? (
        <>
          <Action
            accessibilityLabel="The other person picked a different figure"
            disabled={verify.disabled}
            onPress={() => verify.confirm(false)}
          />
          <Action
            accessibilityLabel="The other person picked this figure"
            disabled={verify.disabled}
            onPress={() => verify.confirm(true)}
          />
        </>
      ) : verify.mode ? (
        <Action
          accessibilityLabel={
            verify.mode === 'invalid' ? 'Stop invalid pairing attempt' : 'stop pairing'
          }
          onPress={verify.cancel}
        />
      ) : null}
    </>
  );
}

function Action({
  accessibilityLabel,
  disabled = false,
  onPress,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
    >
      <Text>{accessibilityLabel}</Text>
    </Pressable>
  );
}

describe('usePairingVerification', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('renders four accessible picker options and submits the selected index', async () => {
    const onChoose = jest.fn(async () => {});
    act(() => {
      renderer = create(<Harness verifications={[verification()]} onChoose={onChoose} />);
    });

    const target = pairingFigure(42);
    const choice = renderer.root.findByProps({
      accessibilityLabel: `Pairing figure: ${target.name}`,
    });
    await act(async () => choice.props.onPress());

    expect(onChoose).toHaveBeenCalledWith('session-1', 42);
    const optionLabels = renderer.root
      .findAll((node) => node.props.accessibilityRole === 'radio')
      .map((node) => node.props.accessibilityLabel);
    expect(new Set(optionLabels).size).toBe(4);
  });

  it('requires the displayer to confirm what the other person picked', async () => {
    const onConfirm = jest.fn(async () => {});
    act(() => {
      renderer = create(
        <Harness
          verifications={[verification({ role: 'displayer', optionIndices: [42] })]}
          onConfirm={onConfirm}
        />
      );
    });

    const matched = renderer.root.findByProps({
      accessibilityLabel: 'The other person picked this figure',
    });
    await act(async () => matched.props.onPress());
    expect(onConfirm).toHaveBeenCalledWith('session-1', true);
  });

  it('offers only a way out once this phone has confirmed', () => {
    act(() => {
      renderer = create(<Harness verifications={[verification({ localConfirmed: true })]} />);
    });

    // The agreed figure stays on screen so the other person can still compare against it.
    expect(
      renderer.root.findAllByProps({ testID: 'pairing-target-figure' }).length
    ).toBeGreaterThan(0);
    const actionable = new Set(
      renderer.root
        .findAll((node) => ['radio', 'button'].includes(node.props.accessibilityRole))
        .map((node) => node.props.accessibilityLabel)
    );
    expect([...actionable]).toEqual(['stop pairing']);
  });

  it('fails closed when the native challenge cannot map to the pair/2 catalog', async () => {
    const onCancel = jest.fn(async () => {});
    act(() => {
      renderer = create(
        <Harness
          verifications={[verification({ targetIndex: 256, optionIndices: [1, 2, 3, 256] })]}
          onCancel={onCancel}
        />
      );
    });

    // No figure is drawn and no confirm path exists — only the exit.
    expect(renderer.root.findAll((node) => node.props.accessibilityRole === 'radio')).toHaveLength(
      0
    );
    const stop = renderer.root.findByProps({
      accessibilityLabel: 'Stop invalid pairing attempt',
    });
    await act(async () => stop.props.onPress());
    expect(onCancel).toHaveBeenCalledWith('session-1');
  });

  /**
   * The four acts of the visual check used to share one flat selection tick, which made the tap
   * that GRANTS someone your location feel exactly like the tap that refuses it — on the one
   * screen in the app where the two answers mean opposite things.
   */
  it('gives each act of the visual check its own feel', async () => {
    act(() => {
      renderer = create(<Harness verifications={[verification()]} />);
    });
    const option = renderer.root.findByProps({
      accessibilityLabel: `Pairing figure: ${pairingFigure(42).name}`,
    });
    await act(async () => option.props.onPress());
    expect(mockHaptics.selectionHaptic).toHaveBeenCalledTimes(1);
    expect(mockHaptics.successHaptic).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    act(() => {
      renderer = create(
        <Harness verifications={[verification({ role: 'displayer', optionIndices: [42] })]} />
      );
    });
    const matched = renderer.root.findByProps({
      accessibilityLabel: 'The other person picked this figure',
    });
    await act(async () => matched.props.onPress());
    expect(mockHaptics.successHaptic).toHaveBeenCalledTimes(1);
    expect(mockHaptics.warningHaptic).not.toHaveBeenCalled();
    act(() => renderer.unmount());

    act(() => {
      renderer = create(
        <Harness verifications={[verification({ role: 'displayer', optionIndices: [42] })]} />
      );
    });
    const different = renderer.root.findByProps({
      accessibilityLabel: 'The other person picked a different figure',
    });
    await act(async () => different.props.onPress());
    expect(mockHaptics.warningHaptic).toHaveBeenCalledTimes(1);
    expect(mockHaptics.successHaptic).toHaveBeenCalledTimes(1);
  });

  it('keeps the exit live after the verification window closes', async () => {
    const onCancel = jest.fn(async () => {});
    const onConfirm = jest.fn(async () => {});
    act(() => {
      renderer = create(
        <Harness
          verifications={[
            verification({ role: 'displayer', optionIndices: [42], deadlineMs: Date.now() - 1000 }),
          ]}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      );
    });
    // Let the clock tick land so the hook knows the window has closed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    const matched = renderer.root.findByProps({
      accessibilityLabel: 'The other person picked this figure',
    });
    await act(async () => matched.props.onPress());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
