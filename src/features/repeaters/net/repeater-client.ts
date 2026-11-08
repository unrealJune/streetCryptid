import {
  tryGetIrohLocation,
  type NativeRepeaterClaim,
  type NativeRepeaterRoster,
} from 'iroh-location';

/** What an owner can change about their roster. */
export interface RepeaterOwnerCalls {
  setPolicy(rosterId: string, open: boolean): Promise<void>;
  removeMember(rosterId: string, member: string): Promise<void>;
  removeMachine(rosterId: string, repeaterId: string): Promise<void>;
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
  const { setRepeaterPolicy, removeRepeaterMember, removeRepeater } = mod;
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
        }
      : null;
  return {
    rosters: () => repeaterRosters.call(mod),
    claim: (link, open, carryMe) => claimRepeater.call(mod, link, open, carryMe),
    setCarried: (rosterId, carry) => setRepeaterCarried.call(mod, rosterId, carry),
    owner,
  };
}
