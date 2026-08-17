import { mergeProfileIntoFriend } from './profile';
import type { Friend } from './types';
import type { ProfileView } from 'iroh-location';

/**
 * The sharing pool / roster model — a pure, immutable state container.
 *
 * `friends`     — everyone we've added (by their endpointId).
 * `sharingWith` — the subset of friends we currently wrap our fixes for. Revoking a
 *                 friend just removes them here; because every fix uses a fresh random
 *                 content key, dropped friends can't read new fixes even though they may
 *                 still replicate the (undecryptable) ciphertext. See ARCHITECTURE.md §6.
 *
 * `sharingWith` is also the authorisation boundary for **live mode** (§9c): a friend we already
 * share with may switch us to the real-time cadence, with no further per-friend permission. That
 * is deliberate — sharing is itself an explicit grant on top of an SAS-verified bilateral pairing,
 * and live mode reveals nothing new, only the same stream more often. It stays bounded by a TTL and
 * visibly interruptible instead of gated behind another toggle.
 */
export interface PoolState {
  readonly friends: Readonly<Record<string, Friend>>;
  readonly sharingWith: readonly string[];
}

export function emptyPool(): PoolState {
  return { friends: {}, sharingWith: [] };
}

export function addFriend(state: PoolState, friend: Friend): PoolState {
  return { ...state, friends: { ...state.friends, [friend.endpointId]: friend } };
}

export function removeFriend(state: PoolState, endpointId: string): PoolState {
  const friends = { ...state.friends };
  delete friends[endpointId];
  return { friends, sharingWith: state.sharingWith.filter((id) => id !== endpointId) };
}

/** Start sharing our location with a friend (no-op if unknown or already sharing). */
export function shareWith(state: PoolState, endpointId: string): PoolState {
  if (!state.friends[endpointId] || state.sharingWith.includes(endpointId)) {
    return state;
  }
  return { ...state, sharingWith: [...state.sharingWith, endpointId] };
}

/** Stop sharing with a friend (revocation). Also ends any live session — they lose the wrap. */
export function revoke(state: PoolState, endpointId: string): PoolState {
  return { ...state, sharingWith: state.sharingWith.filter((id) => id !== endpointId) };
}

export function isSharingWith(state: PoolState, endpointId: string): boolean {
  return state.sharingWith.includes(endpointId);
}

/**
 * Merge a verified profile into a KNOWN friend, but only when it is newer (monotonic by epoch).
 * Returns the same reference when the profile is unknown or not newer, so callers can skip
 * persisting / emitting on a no-op. Never adds a friend — profiles for strangers are ignored.
 */
export function applyProfile(state: PoolState, profile: ProfileView): PoolState {
  const friend = state.friends[profile.endpointId];
  if (!friend) return state;
  const merged = mergeProfileIntoFriend(friend, profile);
  if (merged === friend) return state;
  return { ...state, friends: { ...state.friends, [profile.endpointId]: merged } };
}

export function friendList(state: PoolState): Friend[] {
  return Object.values(state.friends);
}

/** The friends we're actively sharing with (the wrap recipients). */
export function recipients(state: PoolState): Friend[] {
  return state.sharingWith
    .map((id) => state.friends[id])
    .filter((f): f is Friend => f !== undefined);
}

/**
 * The X25519 receiving public keys to wrap the next fix for.
 *
 * **No longer used by the fix lanes.** Every fix lane is envelope v3 now, keyed by ratchet
 * session and therefore addressed by endpoint id — see {@link recipientEndpoints}. Receiving keys
 * remain the address for the lanes that cannot be ratcheted: control messages, and the §4.6
 * resync record, which is the thing that re-establishes a ratchet and so cannot depend on one.
 */
export function recipientRecvKeys(state: PoolState): string[] {
  return recipients(state).map((f) => f.recvPublic);
}

/** The endpoint ids to address the next ratcheted fix to (FORWARD-SECRECY.md §4.7). */
export function recipientEndpoints(state: PoolState): string[] {
  return recipients(state).map((f) => f.endpointId);
}

/**
 * The friends we are NOT sharing position with — the **watcher edges** (FORWARD-SECRECY.md §4.1).
 *
 * Every sharing relationship runs the protocol in both directions: these friends get a null fix
 * (an envelope with an empty padded payload) on the same cadence the friends in {@link recipients}
 * get a real one. That is what keeps a one-directional edge symmetric, so the watching side still
 * contributes fresh key material and the stash cannot tell the two lanes apart by ciphertext size.
 *
 * Disjoint from {@link recipients} by construction — no friend is ever in both, so no recipient
 * ever sees two envelopes from the same tick.
 */
export function watchers(state: PoolState): Friend[] {
  return friendList(state).filter((f) => !state.sharingWith.includes(f.endpointId));
}

/** The X25519 receiving public keys to wrap the next null fix for. See {@link recipientRecvKeys}. */
export function watcherRecvKeys(state: PoolState): string[] {
  return watchers(state).map((f) => f.recvPublic);
}

/** The endpoint ids to address the next ratcheted null fix to (FORWARD-SECRECY.md §4.1). */
export function watcherEndpoints(state: PoolState): string[] {
  return watchers(state).map((f) => f.endpointId);
}
