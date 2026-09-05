import { useCallback } from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { CryptidThemes } from '@/constants/theme';
import { DEV_TELEMETRY_ENABLED } from '@/features/dev/telemetry';
import { DELIVERY_MODE_COPY } from '@/features/social/core/delivery-mode';
import { useMapColorScheme } from '@/features/map/hooks/use-map-color-scheme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { getAppProvenance } from '../core/app-provenance';
import { IdentityRow } from '../components/identity-row';
import { SettingsMenuRow } from '../components/settings-menu-row';
import { SettingsPage } from '../components/settings-page';

/**
 * The Settings menu — the sheet's root, pulled over the map.
 *
 * This used to be one scroll containing every control in the app, which had grown
 * past the point where anything could be found in it. It is now a menu: your own
 * identity first (unchanged — it was already a row that opens a page), then one
 * entry per area, each with the state it currently holds so the menu still answers
 * "what is switched on" without opening anything.
 *
 * The pages themselves live in `../screens/`, mounted at `src/app/settings/*`. There
 * is no tab bar and no native header anywhere in the sheet, so every page draws its
 * own dismissal — see {@link SettingsPage}.
 */
export default function SettingsScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { snapshot, refreshPairing } = useLocationSharing();
  const { selected: mapScheme } = useMapColorScheme();

  // The menu's summaries come straight off the sharing snapshot, which is pushed;
  // pairing is the one piece that has to be pulled, and the pairing page needs it
  // to be warm by the time it mounts.
  useFocusEffect(
    useCallback(() => {
      void refreshPairing();
    }, [refreshPairing])
  );

  const transports = snapshot?.transports ?? { relay: true, ip: true, ble: true };
  const transportValues = Object.values(transports);
  const transportsOn = transportValues.filter(Boolean).length;
  // The EFFECTIVE route, not the stored one: the menu is a summary of what is happening, and a
  // build with no stash deployed is travelling direct whatever the preference still says.
  const delivery = snapshot?.delivery.effectiveMode ?? 'mutual';

  return (
    <SettingsPage
      kind="root"
      title="Settings"
      subtitle="Identity, transports, and offline delivery"
    >
      <View style={styles.menu}>
        <IdentityRow accent={chrome.amber} />
        <SettingsMenuRow
          href="/settings/transports"
          label="Transports"
          detail="Which paths the node may use, and what each one is doing right now."
          value={`${transportsOn}/${transportValues.length} on`}
          accent={transportsOn > 0 ? chrome.green : chrome.amber}
        />
        <SettingsMenuRow
          href="/settings/pairing"
          label="Link pairing"
          detail="Pair by invite link when two phones cannot physically meet."
        />
        <SettingsMenuRow
          href="/settings/delivery"
          label="Delivery options"
          detail="How your location travels, background access, and how often you publish."
          value={DELIVERY_MODE_COPY[delivery].title}
          accent={chrome.green}
        />
        <SettingsMenuRow
          href="/settings/appearance"
          label="Appearance"
          detail="The map's color scheme, in light and dark."
          value={mapScheme.name}
        />
        <SettingsMenuRow
          href="/settings/app-data"
          label="App & data"
          detail="Exploration backup, your author ID, and which build this is."
          value={getAppProvenance().appVersion}
        />
        <SettingsMenuRow
          href="/settings/debug"
          label="Debug"
          detail="Forced pushes, the onboarding preview, and the event journal."
          value={DEV_TELEMETRY_ENABLED ? 'Telemetry on' : null}
          accent={DEV_TELEMETRY_ENABLED ? chrome.amber : undefined}
        />
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // No gap: each row draws its own hairline, so the entries butt together into one
  // continuous list the way IdentityRow already did on its own.
  menu: {
    gap: 0,
  },
});
