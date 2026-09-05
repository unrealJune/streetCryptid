import { useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes } from '@/constants/theme';
import { StashSettingRow } from '@/features/social/components/stash-setting-row';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { DEFAULT_SHARE_INTERVAL_MS } from '@/features/social/net/background/sampling-policy';

import { LocationAccessRow } from '../components/location-access-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';
import { ShareIntervalRow } from '../components/share-interval-row';

/**
 * Everything that decides whether, how often, and by what route your trail reaches
 * a friend: the OS-level permission that lets it be captured at all, the cadence it
 * is published at, and offline delivery through the trail stash.
 *
 * Stash delivery lives here "for now" — it is the only offline-delivery mechanism
 * there is, so it doesn't yet warrant a page of its own.
 */
export default function DeliveryScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const {
    snapshot,
    setStashOptIn,
    setShareInterval,
    disclosureStatus,
    acknowledgeLocationDisclosure,
  } = useLocationSharing();

  const stash = snapshot?.stash ?? { available: false, optedIn: false };
  const shareIntervalMs = snapshot?.shareIntervalMs ?? DEFAULT_SHARE_INTERVAL_MS;

  return (
    <SettingsPage title="Delivery options" subtitle="What you publish, and how it travels">
      <SettingsSection label="ACCESS">
        <LocationAccessRow
          accent={chrome.amber}
          status={disclosureStatus}
          onTurnOn={() => void acknowledgeLocationDisclosure(true)}
        />
      </SettingsSection>

      <SettingsSection label="CADENCE">
        <ShareIntervalRow
          accent={chrome.amber}
          intervalMs={shareIntervalMs}
          onSelect={(intervalMs) => void setShareInterval(intervalMs)}
        />
      </SettingsSection>

      <SettingsSection label="OFFLINE DELIVERY">
        {stash.available ? (
          <StashSettingRow
            accent={chrome.green}
            optedIn={stash.optedIn}
            onToggle={(optedIn) => void setStashOptIn(optedIn)}
          />
        ) : (
          <ThemedText type="small" themeColor="textSecondary">
            No trail stash is deployed for this app, so offline delivery is unavailable. Point
            EXPO_PUBLIC_TRAIL_STASH_URL/TICKET at a stash to enable it.
          </ThemedText>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
