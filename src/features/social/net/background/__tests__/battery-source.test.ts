import { createNullBatterySource, powerStateToBattery } from '../battery-source';

// expo-battery BatteryState: UNKNOWN 0, UNPLUGGED 1, CHARGING 2, FULL 3, NOT_CHARGING 4
describe('powerStateToBattery', () => {
  it('maps a discharging phone to not-charging with its level and low-power flag', () => {
    expect(
      powerStateToBattery({ batteryLevel: 0.42, batteryState: 1, lowPowerMode: true })
    ).toEqual({ level: 0.42, charging: false, lowPower: true });
  });

  it('treats charging, full, and (Android) not-charging-but-connected as charging', () => {
    for (const batteryState of [2, 3, 4]) {
      expect(
        powerStateToBattery({ batteryLevel: 0.5, batteryState, lowPowerMode: false }).charging
      ).toBe(true);
    }
  });

  it('treats unknown state as not charging (assume on battery)', () => {
    expect(
      powerStateToBattery({ batteryLevel: 0.5, batteryState: 0, lowPowerMode: false }).charging
    ).toBe(false);
  });

  it('assumes full battery when the level is unavailable (-1)', () => {
    expect(
      powerStateToBattery({ batteryLevel: -1, batteryState: 0, lowPowerMode: false }).level
    ).toBe(1);
  });
});

describe('null battery source', () => {
  it('reads full battery and never emits events', async () => {
    const source = createNullBatterySource();
    expect(await source.read()).toEqual({ level: 1, charging: false, lowPower: false });
    const onChange = jest.fn();
    const unsub = source.subscribe(onChange);
    unsub();
    expect(onChange).not.toHaveBeenCalled();
  });
});
