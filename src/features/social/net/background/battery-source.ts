import { Platform } from 'react-native';

import type { BatteryState } from './types';

/**
 * The device-power signal the sampling policy needs, behind a native-free seam so the engine and
 * cadence controller stay unit-testable. `read()` is a point-in-time snapshot; `subscribe()` fires
 * whenever the charge level, charging state, or OS Low-Power/battery-saver mode changes — so the
 * cadence can back off the moment Low Power Mode is toggled, without waiting for the next GPS fix.
 *
 * The real implementation lazily loads `expo-battery`. Merely importing this module stays
 * side-effect-free (it never touches the native module at eval time), so web / Expo Go degrade to
 * the null source instead of throwing.
 */
export interface BatterySource {
  read(): Promise<BatteryState>;
  /** Subscribe to power changes; returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
}

/** expo-battery's `BatteryState` enum values — a stable public contract, inlined to stay native-free. */
const BATTERY_STATE = { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 } as const;

/** The subset of `expo-battery`'s `PowerState` we consume. */
export interface PowerStateLike {
  batteryLevel: number;
  batteryState: number;
  lowPowerMode: boolean;
}

/**
 * Pure mapping from expo-battery's `PowerState` to our {@link BatteryState}. Any plugged state
 * (charging, full, or Android's not-charging-but-connected) counts as `charging` so the policy
 * drops its low-battery penalty. A `-1` level means "unavailable" — assume full so we never punish
 * cadence on a device that can't report its battery.
 */
export function powerStateToBattery(power: PowerStateLike): BatteryState {
  const charging =
    power.batteryState === BATTERY_STATE.CHARGING ||
    power.batteryState === BATTERY_STATE.FULL ||
    power.batteryState === BATTERY_STATE.NOT_CHARGING;
  const level = power.batteryLevel < 0 ? 1 : power.batteryLevel;
  return { level, charging, lowPower: power.lowPowerMode };
}

/** Full battery, no power events. Used on web / Expo Go / when expo-battery is absent. */
export function createNullBatterySource(): BatterySource {
  return {
    async read(): Promise<BatteryState> {
      return { level: 1, charging: false, lowPower: false };
    },
    subscribe(): () => void {
      return () => {};
    },
  };
}

type BatteryModule = typeof import('expo-battery');

let batteryMod: BatteryModule | null | undefined;

function tryBattery(): BatteryModule | null {
  if (batteryMod !== undefined) return batteryMod;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load; see module header
    batteryMod = require('expo-battery') as BatteryModule;
  } catch {
    batteryMod = null;
  }
  return batteryMod;
}

function createExpoBatterySource(mod: BatteryModule): BatterySource {
  return {
    async read(): Promise<BatteryState> {
      const power = await mod.getPowerStateAsync();
      return powerStateToBattery({
        batteryLevel: power.batteryLevel,
        batteryState: Number(power.batteryState),
        lowPowerMode: power.lowPowerMode,
      });
    },
    subscribe(onChange: () => void): () => void {
      const subs = [
        mod.addLowPowerModeListener(() => onChange()),
        mod.addBatteryStateListener(() => onChange()),
        mod.addBatteryLevelListener(() => onChange()),
      ];
      return () => {
        for (const sub of subs) sub.remove();
      };
    },
  };
}

/** The real device-power source when `expo-battery` is present (native), else the null source. */
export function createBatterySource(): BatterySource {
  if (Platform.OS === 'web') return createNullBatterySource();
  const mod = tryBattery();
  return mod ? createExpoBatterySource(mod) : createNullBatterySource();
}
