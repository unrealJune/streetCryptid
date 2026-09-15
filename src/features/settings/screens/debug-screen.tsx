import { useColorScheme } from '@/hooks/use-color-scheme';
import { CryptidThemes } from '@/constants/theme';
import { DEV_TELEMETRY_ENABLED } from '@/features/dev/telemetry';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { DebugLocationControls } from '../components/debug-location-controls';
import { FriendConnectionDetailsRow } from '../components/friend-connection-details-row';
import { EventLogPanel } from '../components/event-log-panel';
import { GlassStatusRow } from '../components/glass-status-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * Force a publish, reveal connection details, and read the local event journal.
 */
export default function DebugScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { forceLocationPush } = useLocationSharing();

  return (
    <SettingsPage title="Debug" backLabel="Advanced">
      <FriendConnectionDetailsRow accent={chrome.green} />
      <SettingsSection label="LIQUID GLASS">
        <GlassStatusRow accent={chrome.green} warningColor={chrome.amber} />
      </SettingsSection>

      <SettingsSection label="LOCATION">
        <DebugLocationControls
          accent={chrome.green}
          warningColor={chrome.amber}
          onPush={forceLocationPush}
        />
      </SettingsSection>

      {/* The journal does not exist in a stripped build, so the viewer would render a
          permanently empty list and read as a bug rather than as an absent feature. */}
      {DEV_TELEMETRY_ENABLED ? (
        <SettingsSection label="EVENT JOURNAL">
          <EventLogPanel activeColor={chrome.green} warningColor={chrome.amber} />
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
