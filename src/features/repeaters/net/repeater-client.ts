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
}

/** The repeater choices made at pairing (REPEATERS.md §4.4). */
export interface RepeaterPairingCalls {
  /** The rosters to offer whoever this phone pairs with next. */
  setOffer(rosterIds: readonly string[]): Promise<void>;
  /**
   * Say yes to a roster offered to me (enrolled at once, or the moment an invite arrives), or
   * take the yes back. Resolves whether it carries me now.
   */
  want(rosterId: string, want: boolean): Promise<boolean>;
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
  /** `null` on a binary that predates offers made at pairing. */
  pairing: RepeaterPairingCalls | null;
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
  const { inviteToRepeater } = mod;
  const invites =
    typeof inviteToRepeater === 'function'
      ? {
          invite: (rosterId: string, member: string) =>
            inviteToRepeater.call(mod, rosterId, member),
        }
      : null;
  const { setPairingRepeaterOffer, wantRepeater } = mod;
  const pairing =
    typeof setPairingRepeaterOffer === 'function' && typeof wantRepeater === 'function'
      ? {
          setOffer: (rosterIds: readonly string[]) =>
            setPairingRepeaterOffer.call(mod, [...rosterIds]),
          want: (rosterId: string, want: boolean) => wantRepeater.call(mod, rosterId, want),
        }
      : null;
  return {
    rosters: () => repeaterRosters.call(mod),
    claim: (link, open, carryMe) => claimRepeater.call(mod, link, open, carryMe),
    setCarried: (rosterId, carry) => setRepeaterCarried.call(mod, rosterId, carry),
    owner,
    invites,
    pairing,
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
