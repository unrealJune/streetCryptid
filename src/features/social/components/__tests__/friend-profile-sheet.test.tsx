import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { FriendPresence } from '../../core/presence';
import type { TrailPoint } from '../../net/background/trail-store';
import { FriendProfileSheet } from '../friend-profile-sheet';

jest.mock('@/global.css', () => ({}));
// The sheet is rendered outside a SafeAreaProvider here; only the padding depends on the insets.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const friend: FriendPresence['friend'] = {
  endpointId: 'aa'.repeat(32),
  handle: '@mothman',
  sigil: '/\\',
  cryptidName: 'Mothman',
  recvPublic: 'bb'.repeat(32),
  ticket: 'ticket',
};

const presence: FriendPresence = {
  friend,
  fix: { lat: 40.1, lon: -80.2, accuracyM: 10, headingDeg: 0, ts: 1_700_000_000_000 },
  distanceM: 120,
  ageMs: 60_000,
  freshness: 'live',
};

function point(seq: number, via?: TrailPoint['via']): TrailPoint {
  return {
    author: friend.endpointId,
    seq,
    fix: { lat: 40.1, lon: -80.2, accuracyM: 10, headingDeg: 0, ts: 1_700_000_000_000 + seq },
    receivedAt: 1_700_000_000_000 + seq,
    ...(via ? { via } : {}),
  };
}

function noop(): Promise<void> {
  return Promise.resolve();
}

function renderSheet(history: readonly TrailPoint[]): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FriendProfileSheet
        history={history}
        presence={presence}
        visible
        sharing
        watching={false}
        watchedUntil={null}
        onClose={() => {}}
        onToggleShare={noop}
        onToggleWatch={noop}
        onStopWatcher={noop}
        onViewMap={() => {}}
        onRemove={noop}
      />
    );
  });
  return renderer;
}

function historyLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string)
    .filter((label) => label.includes(','));
}

describe('FriendProfileSheet history transport', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('badges each retained fix with how it reached this device', () => {
    renderer = renderSheet([point(1, 'relay'), point(2, 'stash')]);
    const rendered = renderer.root
      .findAll((node) => typeof node.props.children === 'string')
      .map((node) => node.props.children as string);

    expect(rendered).toContain('RELAY');
    expect(rendered).toContain('STASH');
  });

  it('names the transport in the row accessibility label', () => {
    renderer = renderSheet([point(1, 'relay')]);
    expect(historyLabels(renderer).some((l) => l.endsWith('received live over a relay'))).toBe(
      true
    );
  });

  it('falls back to an unknown marker for points stored before provenance existed', () => {
    renderer = renderSheet([point(1)]);
    const rendered = renderer.root
      .findAll((node) => typeof node.props.children === 'string')
      .map((node) => node.props.children as string);

    expect(rendered).toContain('—');
    expect(historyLabels(renderer).some((l) => l.endsWith('transport unknown'))).toBe(true);
  });
});
