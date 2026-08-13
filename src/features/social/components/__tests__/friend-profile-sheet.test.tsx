import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { DeliveryDetail, FixTransport } from '../../core/types';
import type { FriendPresence } from '../../core/presence';
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

function presenceWith(via?: FixTransport, delivery?: DeliveryDetail): FriendPresence {
  return {
    friend,
    fix: { lat: 40.1, lon: -80.2, accuracyM: 10, headingDeg: 0, ts: 1_700_000_000_000 },
    distanceM: 120,
    ageMs: 60_000,
    freshness: 'live',
    ...(via ? { via } : {}),
    ...(delivery ? { delivery } : {}),
  };
}

/** Opens the signal-path row, which is the only pressable carrying that accessibility label. */
function openSignalPath(renderer: ReactTestRenderer): void {
  const row = renderer.root.find(
    (node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('SIGNAL PATH:') &&
      typeof node.props.onPress === 'function'
  );
  act(() => (row.props.onPress as () => void)());
}

function noop(): Promise<void> {
  return Promise.resolve();
}

function renderSheet(presence: FriendPresence): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FriendProfileSheet
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

function strings(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

function labels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props.accessibilityLabel === 'string')
    .map((node) => node.props.accessibilityLabel as string);
}

// Friends' history is deliberately not retained (only the newest fix survives), so the transport
// label rides on that one fix rather than on a per-row timeline.
describe('FriendProfileSheet signal path', () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('badges the retained fix with how it reached this device', () => {
    renderer = renderSheet(presenceWith('stash'));
    expect(strings(renderer)).toContain('STASH');
  });

  it('names the transport in the accessibility label', () => {
    renderer = renderSheet(presenceWith('relay'));
    expect(labels(renderer)).toContain(
      'SIGNAL PATH: received live, nearest open path a relay. Double tap for delivery detail.'
    );
  });

  it('falls back to an unknown marker for a fix stored before provenance existed', () => {
    renderer = renderSheet(presenceWith());
    expect(strings(renderer)).toContain('—');
    expect(labels(renderer)).toContain(
      'SIGNAL PATH: transport unknown. Double tap for delivery detail.'
    );
  });

  it('opens a tooltip naming the peer that handed the fix over', () => {
    renderer = renderSheet(
      presenceWith('direct', {
        via: 'direct',
        from: 'cc'.repeat(32),
        fromStash: false,
        paths: [
          { kind: 'direct', address: '203.0.113.7:4433', active: true },
          { kind: 'relay', address: 'https://relay.example.com', active: true },
        ],
      })
    );
    openSignalPath(renderer);

    const shown = strings(renderer);
    expect(shown).toContain('cccccccc…cccc');
    expect(shown).toContain('203.0.113.7:4433');
    // The badge said DIRECT; the tooltip is what reveals the relay path was open too.
    expect(shown).toContain('https://relay.example.com');
  });

  it('tells the user when the native core reported no detail', () => {
    renderer = renderSheet(presenceWith('relay'));
    openSignalPath(renderer);
    expect(strings(renderer).some((s) => s.includes('did not report delivery detail'))).toBe(true);
  });

  it('omits the signal path entirely when no fix has ever arrived', () => {
    renderer = renderSheet({ ...presenceWith('relay'), fix: null, distanceM: null, ageMs: null });
    expect(strings(renderer)).not.toContain('SIGNAL PATH');
  });
});
