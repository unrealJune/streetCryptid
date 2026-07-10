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

/** Stop sharing with a friend (revocation). */
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

/** The X25519 receiving public keys to wrap the next fix for. */
export function recipientRecvKeys(state: PoolState): string[] {
  return recipients(state).map((f) => f.recvPublic);
}
