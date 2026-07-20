import { useCallback } from 'react';
import { ScrollView, StyleSheet, View, useColorScheme } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, MaxContentWidth, Spacing, TopTabInset } from '@/constants/theme';
import { StashSettingRow } from '@/features/social/components/stash-setting-row';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { useTheme } from '@/hooks/use-theme';

import { RelayOnlyRow } from '../components/relay-only-row';
import { TransportDiagnostic } from '../components/transport-diagnostic';

/**
 * The centralized Settings tab: offline-delivery (trail stash) opt-in, a live transport
 * diagnostic covering every path the node can use, and the force-relay-only switch. Everything
 * degrades honestly when the native module is absent (web / Expo Go): the diagnostic shows
 * "unavailable"/"n/a" rows and the toggles persist as preferences.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();

  const {
    snapshot,
    transportReport,
    refreshPairing,
    refreshTransportDiagnostics,
    setStashOptIn,
    setRelayOnly,
  } = useLocationSharing();

  useFocusEffect(
    useCallback(() => {
      void refreshPairing();
      void refreshTransportDiagnostics();
      const timer = setInterval(() => void refreshTransportDiagnostics(), 1000);
      return () => clearInterval(timer);
    }, [refreshPairing, refreshTransportDiagnostics])
  );

  const stash = snapshot?.stash ?? { available: false, optedIn: false };
  const transports = snapshot?.transports ?? { relayOnly: false, relayOnlyEnforced: false };

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + TopTabInset + Spacing.four,
          paddingBottom: insets.bottom + Spacing.six,
        },
      ]}
    >
      <View style={styles.header}>
        <ThemedText type="subtitle">Settings</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Transports and offline delivery
        </ThemedText>
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          TRANSPORTS
        </ThemedText>
        <TransportDiagnostic
          report={transportReport}
          activeColor={chrome.green}
          availableColor={chrome.amber}
        />
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          OFFLINE DELIVERY
        </ThemedText>
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
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          PRIVACY
        </ThemedText>
        <RelayOnlyRow
          accent={chrome.amber}
          relayOnly={transports.relayOnly}
          enforced={transports.relayOnlyEnforced}
          onToggle={(relayOnly) => void setRelayOnly(relayOnly)}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: 'center',
    gap: Spacing.five,
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    width: '100%',
  },
  header: {
    gap: Spacing.one,
  },
  section: {
    gap: Spacing.two,
  },
  sectionLabel: {
    letterSpacing: 1,
  },
});
