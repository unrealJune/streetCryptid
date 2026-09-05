import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { FixTransport, Friend } from '../../core/types';
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

function presenceWith(via?: FixTransport, viaPeer?: string): FriendPresence {
  return {
    friend,
    fix: { lat: 40.1, lon: -80.2, accuracyM: 10, headingDeg: 0, ts: 1_700_000_000_000 },
    distanceM: 120,
    ageMs: 60_000,
    freshness: 'live',
    ...(via ? { via } : {}),
    ...(viaPeer ? { viaPeer } : {}),
  };
}

const mutual: Friend = {
  endpointId: 'bb'.repeat(32),
  handle: '@owlbear',
  sigil: '(o)',
  cryptidName: 'Owlbear',
  recvPublic: 'cc'.repeat(32),
  ticket: 'ticket',
};

function noop(): Promise<void> {
  return Promise.resolve();
}

function renderSheet(
  presence: FriendPresence,
  extra: { peers?: readonly Friend[]; stashEndpointId?: string | null } = {}
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <FriendProfileSheet
        presence={presence}
        visible
        sharing
        peers={extra.peers}
        stashEndpointId={extra.stashEndpointId ?? null}
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

/** Press the SIGNAL PATH row, whichever transport label it is currently showing. */
function pressSignalPath(renderer: ReactTestRenderer): void {
  const row = renderer.root.find(
    (node) =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('SIGNAL PATH:') &&
      typeof node.props.onPress === 'function'
  );
  act(() => row.props.onPress());
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

  it('keeps the deliverer folded away until the row is pressed', () => {
    renderer = renderSheet(presenceWith('relay', mutual.endpointId), { peers: [mutual] });
    expect(strings(renderer)).not.toContain('Forwarded by @owlbear');

    pressSignalPath(renderer);
    expect(strings(renderer)).toContain('Forwarded by @owlbear');

    // …and folds back.
    pressSignalPath(renderer);
    expect(strings(renderer)).not.toContain('Forwarded by @owlbear');
  });

  /**
   * The author's swarm is not this device's address book: a neighbour that is not in our pool is
   * the ordinary case, and it gets an id rather than a name we do not have.
   */
  it('shows an unpaired deliverer as a short id', () => {
    renderer = renderSheet(presenceWith('relay', '3f9c1a' + 'dd'.repeat(29)), { peers: [mutual] });
    pressSignalPath(renderer);

    expect(strings(renderer)).toContain("Forwarded by a device you haven't paired with");
    expect(strings(renderer)).toContain('3f9c1a…');
  });

  it('says nothing was recorded when the fix carried no deliverer', () => {
    renderer = renderSheet(presenceWith('live'));
    pressSignalPath(renderer);

    expect(strings(renderer)).toContain('Deliverer not recorded');
  });

  it('shows fix and null ratchet acknowledgement activity', () => {
    renderer = renderSheet(presenceWith('relay'));
    expect(strings(renderer)).toContain('LAST FIX ACK');
    expect(strings(renderer)).toContain('Now · live');
    expect(strings(renderer)).toContain('2 min ago · sync');
  });
});
