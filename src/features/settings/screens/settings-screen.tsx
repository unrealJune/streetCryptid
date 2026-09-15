import { useCallback } from 'react';
import { type Href, useFocusEffect } from 'expo-router';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { CryptidThemes } from '@/constants/theme';
import { DELIVERY_MODE_COPY } from '@/features/social/core/delivery-mode';
import { useMapColorScheme } from '@/features/map/hooks/use-map-color-scheme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { getAppProvenance } from '../core/app-provenance';
import { IdentityRow } from '../components/identity-row';
import { SettingsMenuRow } from '../components/settings-menu-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * The Settings menu — the sheet's root, pulled over the map.
 *
 * This used to be one scroll containing every control in the app, which had grown past the
 * point where anything could be found in it. It is now a menu: your own cryptid on a plate
 * at the top, then one entry per area, each carrying the state it currently holds so the
 * menu still answers "what is switched on" without opening anything.
 *
 * The two sections are the app's own distinction, not a filing convention: SHARING is
 * everything that changes what your friends receive, THIS PHONE is everything that changes
 * nothing outside this install. Display preferences really are local-only (see
 * `core/display-preferences.ts`), which is why Appearance sits below the line and Delivery
 * sits above it.
 *
 * The pages themselves live in `../screens/`, mounted at `src/app/settings/*`. There is no
 * tab bar and no native header anywhere in the sheet, so every page draws its own
 * dismissal — see {@link SettingsPage}.
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
  // build with no stash deployed uses mutual friends whatever the preference still says. When
  // the two disagree the readout goes amber, because "we are not doing what you asked for" is
  // the one thing about delivery a menu row can usefully raise on its own.
  const delivery = snapshot?.delivery.effectiveMode ?? 'mutual';
  const deliveryHonoured = snapshot ? snapshot.delivery.mode === delivery : true;

  const friends = snapshot?.friends.length ?? 0;
  const transports = snapshot?.transports ?? { relay: true, ip: true, ble: true };
  // Only the paths that are actually permitted are named. A list of everything with the
  // disabled ones crossed out says the same thing in more words, and the case that matters —
  // no path at all, so nothing can leave this phone — has to be legible without counting.
  const enabledTransports = (
    [
      ['relay', 'Relay'],
      ['ip', 'Direct'],
      ['ble', 'BLE'],
    ] as const
  )
    .filter(([key]) => transports[key])
    .map(([, name]) => name);

  const provenance = getAppProvenance();

  return (
    <SettingsPage kind="root" title="Settings">
      <IdentityRow accent={chrome.amber} />

      <SettingsSection label="Sharing">
        <SettingsMenuRow
          href="/settings/delivery"
          label="Delivery"
          value={DELIVERY_MODE_COPY[delivery].title}
          accent={deliveryHonoured ? chrome.green : chrome.amber}
        />
        <SettingsMenuRow
          href={'/pairing' as Href}
          label="Pair"
          value={
            friends === 0
              ? 'Nobody paired yet'
              : `${friends} ${friends === 1 ? 'friend' : 'friends'}`
          }
        />
      </SettingsSection>

      <SettingsSection label="This phone">
        <SettingsMenuRow
          href="/settings/appearance"
          label="Appearance"
          value={`${mapScheme.name} · ${scheme === 'dark' ? 'Dark' : 'Light'}`}
        />
        <SettingsMenuRow
          href={'/settings/advanced' as Href}
          label="Advanced"
          value={
            enabledTransports.length > 0 ? enabledTransports.join(' · ') : 'No transports enabled'
          }
          accent={enabledTransports.length > 0 ? undefined : chrome.amber}
        />
        <SettingsMenuRow
          href="/settings/app-data"
          label="App & Data"
          value={
            provenance.buildVersion
              ? `${provenance.appVersion} (${provenance.buildVersion})`
              : provenance.appVersion
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}
