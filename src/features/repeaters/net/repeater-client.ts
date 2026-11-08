import {
  tryGetIrohLocation,
  type NativeRepeaterClaim,
  type NativeRepeaterRoster,
} from 'iroh-location';

/**
 * The native repeater calls (`modules/iroh-location/rust/src/repeater.rs`), or `null` where the
 * binary has none: web, Expo Go, and an installed build older than this bundle. Every call is
 * optional on the module, so a missing one means "unsupported", never a crash.
 */
export interface RepeaterClient {
  rosters(): Promise<NativeRepeaterRoster[]>;
  claim(link: string, open: boolean, carryMe: boolean): Promise<NativeRepeaterClaim>;
  setCarried(rosterId: string, carry: boolean): Promise<boolean>;
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
  return {
    rosters: () => repeaterRosters.call(mod),
    claim: (link, open, carryMe) => claimRepeater.call(mod, link, open, carryMe),
    setCarried: (rosterId, carry) => setRepeaterCarried.call(mod, rosterId, carry),
  };
}
