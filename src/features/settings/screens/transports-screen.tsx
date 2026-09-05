import { useCallback } from 'react';
import { useColorScheme } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { CryptidThemes } from '@/constants/theme';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { SettingsPage, SettingsSection } from '../components/settings-page';
import { TransportControls } from '../components/transport-controls';
import { TransportDiagnostic } from '../components/transport-diagnostic';

/**
 * Every path the node can use: a live diagnostic of what each one is actually
 * doing, and the switches that permit or forbid it.
 *
 * The 1s diagnostic poll is deliberately scoped to this page. It used to run for
 * as long as Settings was open, which meant it ran while you were reading about
 * anything else; a diagnostic nobody is looking at is just battery.
 *
 * Degrades honestly with no native module (web / Expo Go): the diagnostic shows
 * "unavailable"/"n/a" rows and the toggles persist as plain preferences.
 */
export default function TransportsScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { snapshot, transportReport, refreshTransportDiagnostics, setTransportEnabled } =
    useLocationSharing();

  useFocusEffect(
    useCallback(() => {
      void refreshTransportDiagnostics();
      const timer = setInterval(() => void refreshTransportDiagnostics(), 1000);
      return () => clearInterval(timer);
    }, [refreshTransportDiagnostics])
  );

  const transports = snapshot?.transports ?? { relay: true, ip: true, ble: true };

  return (
    <SettingsPage title="Transports" subtitle="How this phone reaches your friends">
      <SettingsSection label="LIVE PATHS">
        <TransportDiagnostic
          report={transportReport}
          activeColor={chrome.green}
          availableColor={chrome.amber}
        />
      </SettingsSection>

      <SettingsSection label="PERMITTED">
        <TransportControls
          accent={chrome.green}
          preferences={transports}
          onToggle={(transport, enabled) => void setTransportEnabled(transport, enabled)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
