import type { ProfileView } from 'iroh-location';

import { addFriend, applyProfile, emptyPool, friendList } from '../pool';
import { isNewerProfile, mergeProfileIntoFriend } from '../profile';
import type { Friend } from '../types';

const legacyFriend: Friend = {
  endpointId: 'bbbb',
  handle: '@bee',
  sigil: 'jackalope',
  recvPublic: 'b0b0',
  ticket: 'ticket-b',
};

function profile(overrides: Partial<ProfileView> = {}): ProfileView {
  return {
    endpointId: 'bbbb',
    epoch: 100,
    handle: '@beeNew',
    cryptidName: 'Jackalope',
    sigil: 'new-jackalope',
    color: '#337FBE',
    recvPub: 'newrecv',
    ts: 100,
    ...overrides,
  };
}

describe('profile merge', () => {
  it('merges a newer verified profile into a legacy friend (no epoch yet)', () => {
    const merged = mergeProfileIntoFriend(legacyFriend, profile());
    expect(merged).toMatchObject({
      handle: '@beeNew',
      sigil: 'new-jackalope',
      recvPublic: 'newrecv',
      cryptidName: 'Jackalope',
      color: '#337FBE',
      profileEpoch: 100,
    });
    // Non-profile fields are preserved.
    expect(merged.ticket).toBe('ticket-b');
  });

  it('is monotonic: an equal or older epoch is a no-op and returns the same reference', () => {
    const current = mergeProfileIntoFriend(legacyFriend, profile({ epoch: 100 }));
    expect(mergeProfileIntoFriend(current, profile({ epoch: 100, handle: '@stale' }))).toBe(
      current
    );
    expect(mergeProfileIntoFriend(current, profile({ epoch: 50, handle: '@older' }))).toBe(current);
  });

  it('treats epoch 0 (web no-capability stub) as not newer', () => {
    expect(isNewerProfile(legacyFriend, profile({ epoch: 0 }))).toBe(false);
    expect(mergeProfileIntoFriend(legacyFriend, profile({ epoch: 0 }))).toBe(legacyFriend);
  });

  it('never blanks fields with empty profile values', () => {
    const merged = mergeProfileIntoFriend(
      legacyFriend,
      profile({ handle: '', sigil: '', recvPub: '', cryptidName: '', color: '' })
    );
    expect(merged.handle).toBe('@bee');
    expect(merged.sigil).toBe('jackalope');
    expect(merged.recvPublic).toBe('b0b0');
  });
});

describe('pool.applyProfile', () => {
  it('updates a known friend when the profile is newer', () => {
    const state = applyProfile(addFriend(emptyPool(), legacyFriend), profile({ epoch: 200 }));
    expect(friendList(state)[0]).toMatchObject({ handle: '@beeNew', profileEpoch: 200 });
  });

  it('ignores profiles for unknown friends (never adds strangers)', () => {
    const state = applyProfile(emptyPool(), profile({ endpointId: 'zzzz' }));
    expect(friendList(state)).toHaveLength(0);
  });

  it('returns the same reference when nothing changed (older epoch)', () => {
    let state = applyProfile(addFriend(emptyPool(), legacyFriend), profile({ epoch: 200 }));
    const same = applyProfile(state, profile({ epoch: 150 }));
    expect(same).toBe(state);
  });
});
