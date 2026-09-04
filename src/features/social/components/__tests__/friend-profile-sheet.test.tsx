import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { FixTransport } from '../../core/types';
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

function presenceWith(via?: FixTransport): FriendPresence {
  return {
    friend,
    fix: { lat: 40.1, lon: -80.2, accuracyM: 10, headingDeg: 0, ts: 1_700_000_000_000 },
    distanceM: 120,
    ageMs: 60_000,
    contactAgeMs: 60_000,
    state: 'live',
    freshness: 'live',
    ...(via ? { via } : {}),
  };
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
        ratchetActivity={{
          fix: { seq: 12, receivedAt: Date.now(), source: 'live' },
          null: { seq: 13, receivedAt: Date.now() - 120_000, source: 'durable' },
        }}
        onClose={() => {}}
        onToggleShare={noop}
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
    expect(labels(renderer)).toContain('SIGNAL PATH: received live, nearest open path a relay');
  });

  it('falls back to an unknown marker for a fix stored before provenance existed', () => {
    renderer = renderSheet(presenceWith());
    expect(strings(renderer)).toContain('—');
    expect(labels(renderer)).toContain('SIGNAL PATH: transport unknown');
  });

  it('omits the signal path entirely when no fix has ever arrived', () => {
    renderer = renderSheet({ ...presenceWith('relay'), fix: null, distanceM: null, ageMs: null });
    expect(strings(renderer)).not.toContain('SIGNAL PATH');
  });

  it('shows fix and null ratchet acknowledgement activity', () => {
    renderer = renderSheet(presenceWith('relay'));
    expect(strings(renderer)).toContain('LAST FIX ACK');
    expect(strings(renderer)).toContain('Now · live');
    expect(strings(renderer)).toContain('2 min ago · sync');
  });
});
