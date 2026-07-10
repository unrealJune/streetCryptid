import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { pairingFigure } from '../../core/pairing-figures';
import type { PairingVerification } from '../../net/location-sharing';
import { PairingVerificationPanel } from '../pairing-verification-panel';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(async () => {}),
}));

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

describe('PairingVerificationPanel', () => {
  let renderer: ReactTestRenderer;

  afterEach(() => {
    act(() => renderer?.unmount());
  });

  it('renders four accessible picker options and submits the selected index', async () => {
    const onChoose = jest.fn(async () => {});
    act(() => {
      renderer = create(
        <PairingVerificationPanel
          accent="#2f9e6a"
          verifications={[verification()]}
          onChoose={onChoose}
          onConfirm={async () => {}}
          onCancel={async () => {}}
        />
      );
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
        <PairingVerificationPanel
          accent="#2f9e6a"
          verifications={[verification({ role: 'displayer', optionIndices: [42] })]}
          onChoose={async () => {}}
          onConfirm={onConfirm}
          onCancel={async () => {}}
        />
      );
    });

    const matched = renderer.root.findByProps({
      accessibilityLabel: 'The other person picked this figure',
    });
    await act(async () => matched.props.onPress());
    expect(onConfirm).toHaveBeenCalledWith('session-1', true);
  });

  it('preserves a non-interactive waiting state after this phone confirms', () => {
    act(() => {
      renderer = create(
        <PairingVerificationPanel
          accent="#2f9e6a"
          verifications={[verification({ localConfirmed: true })]}
          onChoose={async () => {}}
          onConfirm={async () => {}}
          onCancel={async () => {}}
        />
      );
    });

    expect(
      renderer.root.findAll((node) => node.props.children === 'Waiting for the other phone').length
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAll((node) => ['radio', 'button'].includes(node.props.accessibilityRole))
    ).toHaveLength(0);
  });

  it('fails closed when the native challenge cannot map to the pair/2 catalog', async () => {
    const onCancel = jest.fn(async () => {});
    act(() => {
      renderer = create(
        <PairingVerificationPanel
          accent="#2f9e6a"
          verifications={[verification({ targetIndex: 256, optionIndices: [1, 2, 3, 256] })]}
          onChoose={async () => {}}
          onConfirm={async () => {}}
          onCancel={onCancel}
        />
      );
    });

    const stop = renderer.root.findByProps({
      accessibilityLabel: 'Stop invalid pairing attempt',
    });
    await act(async () => stop.props.onPress());
    expect(onCancel).toHaveBeenCalledWith('session-1');
  });
});
