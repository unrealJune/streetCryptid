import type { ProfileView } from 'iroh-location';

import type { Friend } from './types';

/**
 * Pure profile-merge helpers. A {@link ProfileView} is already signature- and endpoint-verified by
 * the native layer, so once it belongs to a known friend it can be trusted — but only if it is
 * *newer* than what we already merged. Profiles carry a monotonic, wall-clock-anchored publish
 * `epoch` (ms); the web bridge reports `epoch === 0` when it has no profile capability, which we
 * treat as "nothing to merge". See docs/social/ARCHITECTURE.md §3.
 */

/**
 * True when `profile` is strictly newer than what `friend` already holds. A real epoch is a positive
 * ms timestamp; `epoch <= 0` (e.g. the web no-capability stub) is never newer, and equal epochs are
 * ignored so merges stay idempotent.
 */
export function isNewerProfile(friend: Friend, profile: ProfileView): boolean {
  return profile.epoch > 0 && profile.epoch > (friend.profileEpoch ?? 0);
}

/**
 * Merge a verified `profile` into `friend`, updating `recvPublic`, `handle`, `sigil`, `cryptidName`
 * and `color` and recording the new `profileEpoch`. Returns the *same reference* when the profile
 * isn't newer, so callers can cheaply detect a no-op. Empty profile fields never overwrite existing
 * values (a friend keeps their old handle/sigil rather than being blanked).
 */
export function mergeProfileIntoFriend(friend: Friend, profile: ProfileView): Friend {
  if (!isNewerProfile(friend, profile)) return friend;
  return {
    ...friend,
    handle: profile.handle || friend.handle,
    sigil: profile.sigil || friend.sigil,
    recvPublic: profile.recvPub || friend.recvPublic,
    profileEpoch: profile.epoch,
    ...(profile.cryptidName ? { cryptidName: profile.cryptidName } : {}),
    ...(profile.color ? { color: profile.color } : {}),
  };
}
