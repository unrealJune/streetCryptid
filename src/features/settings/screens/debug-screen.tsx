import { useColorScheme } from 'react-native';

import { CryptidThemes } from '@/constants/theme';
import { ProfileOnboardingPreview } from '@/features/account/components/profile-onboarding-preview';
import { DEV_TELEMETRY_ENABLED } from '@/features/dev/telemetry';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { DebugLocationControls } from '../components/debug-location-controls';
import { EventLogPanel } from '../components/event-log-panel';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * The instruments: force a publish, replay first-run onboarding without saving, and
 * read the local event journal.
 */
export default function DebugScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { forceLocationPush } = useLocationSharing();

  return (
    <SettingsPage title="Debug" subtitle="Instruments, not settings">
      <SettingsSection label="LOCATION">
        <DebugLocationControls
          accent={chrome.green}
          warningColor={chrome.amber}
          onPush={forceLocationPush}
        />
      </SettingsSection>

      <SettingsSection label="ONBOARDING">
        <ProfileOnboardingPreview accent={chrome.green} />
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
