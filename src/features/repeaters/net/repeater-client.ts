import {
  tryGetIrohLocation,
  type NativeRepeaterClaim,
  type NativeRepeaterHealth,
  type NativeRepeaterRoster,
} from 'iroh-location';

/** What an owner can change about their roster. */
export interface RepeaterOwnerCalls {
  setPolicy(rosterId: string, open: boolean): Promise<void>;
  removeMember(rosterId: string, member: string): Promise<void>;
  removeMachine(rosterId: string, repeaterId: string): Promise<void>;
  /** `null` on a binary that predates inviters. */
  setInviter: ((rosterId: string, member: string, inviter: boolean) => Promise<void>) | null;
}

/** Inviting people to invite-only rosters (REPEATERS.md §3.2, §4.4). */
export interface RepeaterInviteCalls {
  /** Invite one person to one roster. Resolves whether a new invite was signed. */
  invite(rosterId: string, member: string): Promise<boolean>;
  /** Invite a new friend to every roster this phone may invite to. Resolves how many. */
  inviteFriend(member: string): Promise<number>;
  autoInvite(): Promise<boolean>;
  setAutoInvite(on: boolean): Promise<void>;
}

/**
 * The native repeater calls (`modules/iroh-location/rust/src/repeater.rs`), or `null` where the
 * binary has none: web, Expo Go, and an installed build older than this bundle. Every call is
 * optional on the module, so a missing one means "unsupported", never a crash.
 */
export interface RepeaterClient {
  rosters(): Promise<NativeRepeaterRoster[]>;
  claim(link: string, open: boolean, carryMe: boolean): Promise<NativeRepeaterClaim>;
  setCarried(rosterId: string, carry: boolean): Promise<boolean>;
  /** `null` on a binary that can claim but predates the owner's controls. */
  owner: RepeaterOwnerCalls | null;
  /** `null` on a binary that predates invites. */
  invites: RepeaterInviteCalls | null;
  /**
   * Pick up names this phone's own machines were given at their consoles; resolves how many
   * changed. Dials each machine. `null` on a binary that predates repeater names.
   */
  refreshNames: (() => Promise<number>) | null;
}

export function getRepeaterClient(): RepeaterClient | null {
  const mod = tryGetIrohLocation();
  if (
    !mod ||
    typeof mod.repeaterRosters !== 'function' ||
    typeof mod.claimRepeater !== 'function' ||
    typeof mod.setRepeaterCarried !== 'function'
  ) {
    return null;
  }
  const { repeaterRosters, claimRepeater, setRepeaterCarried } = mod;
  const { setRepeaterPolicy, removeRepeaterMember, removeRepeater, setRepeaterInviter } = mod;
  const owner =
    typeof setRepeaterPolicy === 'function' &&
    typeof removeRepeaterMember === 'function' &&
    typeof removeRepeater === 'function'
      ? {
          setPolicy: (rosterId: string, open: boolean) =>
            setRepeaterPolicy.call(mod, rosterId, open),
          removeMember: (rosterId: string, member: string) =>
            removeRepeaterMember.call(mod, rosterId, member),
          removeMachine: (rosterId: string, repeaterId: string) =>
            removeRepeater.call(mod, rosterId, repeaterId),
          setInviter:
            typeof setRepeaterInviter === 'function'
              ? (rosterId: string, member: string, inviter: boolean) =>
                  setRepeaterInviter.call(mod, rosterId, member, inviter)
              : null,
        }
      : null;
  const { inviteToRepeater, inviteFriendToRepeaters, repeaterAutoInvite, setRepeaterAutoInvite } =
    mod;
  const invites =
    typeof inviteToRepeater === 'function' &&
    typeof inviteFriendToRepeaters === 'function' &&
    typeof repeaterAutoInvite === 'function' &&
    typeof setRepeaterAutoInvite === 'function'
      ? {
          invite: (rosterId: string, member: string) =>
            inviteToRepeater.call(mod, rosterId, member),
          inviteFriend: (member: string) => inviteFriendToRepeaters.call(mod, member),
          autoInvite: () => repeaterAutoInvite.call(mod),
          setAutoInvite: (on: boolean) => setRepeaterAutoInvite.call(mod, on),
        }
      : null;
  return {
    rosters: () => repeaterRosters.call(mod),
    claim: (link, open, carryMe) => claimRepeater.call(mod, link, open, carryMe),
    setCarried: (rosterId, carry) => setRepeaterCarried.call(mod, rosterId, carry),
    owner,
    invites,
    refreshNames:
      typeof mod.refreshRepeaterNames === 'function'
        ? () => mod.refreshRepeaterNames!.call(mod)
        : null,
  };
}

/**
 * What `device.health` says about repeaters (REPEATERS.md §5), or `null` on a binary without the
 * call. A local read in the core; it never dials.
 */
export async function readRepeaterHealth(): Promise<NativeRepeaterHealth | null> {
  const mod = tryGetIrohLocation();
  if (!mod || typeof mod.repeaterHealth !== 'function') return null;
  try {
    return await mod.repeaterHealth();
  } catch {
    return null;
  }
}
