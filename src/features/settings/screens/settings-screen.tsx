import { useCallback } from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import { type Href, useFocusEffect } from 'expo-router';

import { CryptidThemes } from '@/constants/theme';
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
 * profile first, then one
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

  // The EFFECTIVE route, not the stored one: the menu is a summary of what is happening, and a
  // build with no stash deployed uses mutual friends whatever the preference still says.
  const delivery = snapshot?.delivery.effectiveMode ?? 'mutual';

  return (
    <SettingsPage kind="root" title="Settings">
      <View style={styles.menu}>
        <IdentityRow accent={chrome.amber} />
        <SettingsMenuRow href="/settings/appearance" label="Appearance" value={mapScheme.name} />
        <SettingsMenuRow
          href="/settings/delivery"
          label="Delivery"
          value={DELIVERY_MODE_COPY[delivery].title}
          accent={chrome.green}
        />
        <SettingsMenuRow href={'/pairing' as Href} label="Pair" />
        <SettingsMenuRow href={'/settings/advanced' as Href} label="Advanced" />
        <SettingsMenuRow
          href="/settings/app-data"
          label="App & Data"
          value={getAppProvenance().appVersion}
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
