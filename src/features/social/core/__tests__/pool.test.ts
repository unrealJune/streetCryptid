import {
  addFriend,
  emptyPool,
  friendList,
  isSharingWith,
  recipientRecvKeys,
  recipients,
  removeFriend,
  revoke,
  shareWith,
} from '../pool';
import type { Friend } from '../types';

const b: Friend = {
  endpointId: 'bbbb',
  handle: '@bee',
  sigil: 'jackalope',
  recvPublic: 'b0b0',
  ticket: 'ticket-b',
};
const c: Friend = {
  endpointId: 'cccc',
  handle: '@cee',
  sigil: 'black-shuck',
  recvPublic: 'c0c0',
  ticket: 'ticket-c',
};

describe('sharing pool', () => {
  it('adds friends', () => {
    const s = addFriend(addFriend(emptyPool(), b), c);
    expect(friendList(s)).toHaveLength(2);
  });

  it('only shares with known friends', () => {
    const s = shareWith(emptyPool(), 'unknown');
    expect(s.sharingWith).toHaveLength(0);
  });

  it('shares and lists recipients', () => {
    let s = addFriend(addFriend(emptyPool(), b), c);
    s = shareWith(s, b.endpointId);
    s = shareWith(s, c.endpointId);
    expect(isSharingWith(s, b.endpointId)).toBe(true);
    expect(
      recipients(s)
        .map((f) => f.endpointId)
        .sort()
    ).toEqual(['bbbb', 'cccc']);
    expect(recipientRecvKeys(s).sort()).toEqual(['b0b0', 'c0c0']);
  });

  it('does not double-add a recipient', () => {
    let s = addFriend(emptyPool(), b);
    s = shareWith(s, b.endpointId);
    s = shareWith(s, b.endpointId);
    expect(s.sharingWith).toEqual(['bbbb']);
  });

  it('revokes a recipient (keeps them as a friend)', () => {
    let s = addFriend(addFriend(emptyPool(), b), c);
    s = shareWith(s, b.endpointId);
    s = shareWith(s, c.endpointId);
    s = revoke(s, c.endpointId);
    expect(isSharingWith(s, c.endpointId)).toBe(false);
    expect(recipientRecvKeys(s)).toEqual(['b0b0']); // c can't decrypt new fixes
    expect(friendList(s)).toHaveLength(2); // still a friend
  });

  it('removing a friend also revokes them', () => {
    let s = addFriend(emptyPool(), b);
    s = shareWith(s, b.endpointId);
    s = removeFriend(s, b.endpointId);
    expect(friendList(s)).toHaveLength(0);
    expect(s.sharingWith).toHaveLength(0);
  });
});
