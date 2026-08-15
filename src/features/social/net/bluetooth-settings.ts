import { Linking, Platform } from 'react-native';

/**
 * Send the user to the switch that turns the Bluetooth radio back on.
 *
 * Android exposes the radio toggle as a public settings intent, so we land straight on it.
 * iOS has no public deep link to the Bluetooth toggle (`App-Prefs:` is private API and gets
 * apps rejected), so the best we can do is the app's own settings page — which at least carries
 * the Bluetooth *permission* switch. The strip tells iOS users about Control Centre in words.
 */
export async function openBluetoothSettings(): Promise<void> {
  if (Platform.OS === 'android') {
    try {
      await Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
      return;
    } catch {
      // Some OEM ROMs do not export that activity; the app settings page still works.
    }
  }
  await Linking.openSettings();
}
