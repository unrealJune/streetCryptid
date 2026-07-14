import type { Attributes, Span } from './types';

/**
 * Best-effort device/network snapshot stamped onto wake/publish spans — the "what state was the
 * phone actually in when this ping was (not) sent" attributes. Every native module is lazily
 * required and individually guarded: a missing module (Expo Go, web, an old dev client) degrades
 * to fewer attributes, never to a throw — this runs inside headless background tasks.
 */

type NetworkModule = typeof import('expo-network');
type BatteryModule = typeof import('expo-battery');

let networkMod: NetworkModule | null | undefined;
let batteryMod: BatteryModule | null | undefined;

// Static string literals (not a dynamic `require(name)`): Metro can only resolve
// require() calls whose argument is a literal, so each optional native module gets
// its own guarded loader. Still lazy and best-effort — a missing module returns null.
function tryRequireNetwork(): NetworkModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-network') as NetworkModule;
  } catch {
    return null;
  }
}

function tryRequireBattery(): BatteryModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy, guarded load
    return require('expo-battery') as BatteryModule;
  } catch {
    return null;
  }
}

export async function getSystemSnapshot(): Promise<Attributes> {
  const attrs: Attributes = {};

  if (networkMod === undefined) networkMod = tryRequireNetwork();
  if (networkMod) {
    try {
      const state = await networkMod.getNetworkStateAsync();
      attrs['net.type'] = String(state.type ?? 'unknown');
      if (state.isConnected !== undefined) attrs['net.connected'] = state.isConnected;
      if (state.isInternetReachable !== undefined && state.isInternetReachable !== null) {
        attrs['net.internet_reachable'] = state.isInternetReachable;
      }
    } catch {
      attrs['net.type'] = 'error';
    }
  }

  if (batteryMod === undefined) batteryMod = tryRequireBattery();
  if (batteryMod) {
    try {
      const [level, state, lowPower] = await Promise.all([
        batteryMod.getBatteryLevelAsync(),
        batteryMod.getBatteryStateAsync(),
        batteryMod.isLowPowerModeEnabledAsync(),
      ]);
      if (level >= 0) attrs['battery.level'] = Math.round(level * 100) / 100;
      attrs['battery.state'] = batteryStateName(state);
      attrs['battery.low_power'] = lowPower;
    } catch {
      // battery unavailable (simulator) — omit
    }
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: react-native is always present, but keep the pattern uniform
    const { AppState } = require('react-native') as typeof import('react-native');
    attrs['app.state'] = AppState.currentState ?? 'unknown';
  } catch {
    // non-RN test environment
  }

  return attrs;
}

function batteryStateName(state: number): string {
  // expo-battery BatteryState enum: 0 UNKNOWN, 1 UNPLUGGED, 2 CHARGING, 3 FULL.
  switch (state) {
    case 1:
      return 'unplugged';
    case 2:
      return 'charging';
    case 3:
      return 'full';
    default:
      return 'unknown';
  }
}

/** Fire-and-forget variant: attach the snapshot to `span` without making the caller await it. */
export function attachSystemSnapshot(span: Span): void {
  void getSystemSnapshot().then(
    (attrs) => span.setAttributes(attrs),
    () => {}
  );
}
