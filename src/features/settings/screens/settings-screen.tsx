import { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useColorScheme } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, MaxContentWidth, Spacing } from '@/constants/theme';
import { StashSettingRow } from '@/features/social/components/stash-setting-row';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { DEFAULT_SHARE_INTERVAL_MS } from '@/features/social/net/background/sampling-policy';
import { useTheme } from '@/hooks/use-theme';

import { ProfileOnboardingPreview } from '@/features/account/components/profile-onboarding-preview';

import { AppProvenanceDetails } from '../components/app-provenance';
import { AuthorIdRow } from '../components/author-id-row';
import { CryptidBenchPanel } from '../components/cryptid-bench-panel';
import { DebugLocationControls } from '../components/debug-location-controls';
import { EventLogPanel } from '../components/event-log-panel';
import { IdentityRow } from '../components/identity-row';
import { LocationAccessRow } from '../components/location-access-row';
import { ShareIntervalRow } from '../components/share-interval-row';
import { TransportControls } from '../components/transport-controls';
import { TransportDiagnostic } from '../components/transport-diagnostic';
import { PairLinkAction } from '@/features/social/components/pair-link-action';

/**
 * Settings, pulled over the map as a sheet — there is no tab bar to return to, so
 * it owns its own close affordance.
 *
 * It is the app's one centralized surface: offline-delivery (trail stash) opt-in, a live
 * transport diagnostic covering every path the node can use, and per-transport debug
 * switches. Everything degrades honestly when the native module is absent (web / Expo Go):
 * the diagnostic shows "unavailable"/"n/a" rows and the toggles persist as preferences.
 *
 * It is also where the two social controls that are not "who is out there" now live: your
 * own identity, and the invite-link pairing fallback for when two phones cannot
 * physically meet.
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const {
    snapshot,
    pairing,
    transportReport,
    refreshPairing,
    refreshTransportDiagnostics,
    setStashOptIn,
    setTransportEnabled,
    setShareInterval,
    disclosureStatus,
    acknowledgeLocationDisclosure,
    forceLocationPush,
    createPairInvite,
    pairFromInput,
    respondPair,
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
  const transports = snapshot?.transports ?? { relay: true, ip: true, ble: true };
  const shareIntervalMs = snapshot?.shareIntervalMs ?? DEFAULT_SHARE_INTERVAL_MS;

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + Spacing.four,
          paddingBottom: insets.bottom + Spacing.six,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <ThemedText type="subtitle">Settings</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Identity, transports, and offline delivery
          </ThemedText>
        </View>
        <Pressable
          accessibilityLabel="Close settings"
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => router.back()}
          style={({ pressed }) => [
            styles.close,
            { borderColor: theme.backgroundSelected, opacity: pressed ? 0.55 : 1 },
          ]}
        >
          <SymbolView
            name={{ ios: 'xmark', android: 'close', web: 'close' }}
            size={17}
            tintColor={theme.text}
          />
        </Pressable>
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          IDENTITY
        </ThemedText>
        <IdentityRow accent={chrome.amber} />
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
        <TransportControls
          accent={chrome.green}
          preferences={transports}
          onToggle={(transport, enabled) => void setTransportEnabled(transport, enabled)}
        />
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          PAIRING LINKS
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Bump lives on the map: open the FRIENDS tab and touch two phones together. Use a link only
          when you cannot meet in person.
        </ThemedText>
        {pairing ? (
          <PairLinkAction
            accent={chrome.green}
            errorAccent={chrome.amber}
            pairing={pairing}
            onCreateInvite={createPairInvite}
            onPairInput={pairFromInput}
            onReject={(sessionId) => respondPair(sessionId, false)}
          />
        ) : null}
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          DEBUG
        </ThemedText>
        <DebugLocationControls
          accent={chrome.green}
          warningColor={chrome.amber}
          onPush={forceLocationPush}
        />
        <ProfileOnboardingPreview accent={chrome.green} />
        {__DEV__ ? <CryptidBenchPanel accent={chrome.green} /> : null}
        <EventLogPanel activeColor={chrome.green} warningColor={chrome.amber} />
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
        <LocationAccessRow
          accent={chrome.amber}
          status={disclosureStatus}
          onTurnOn={() => void acknowledgeLocationDisclosure(true)}
        />
        <ShareIntervalRow
          accent={chrome.amber}
          intervalMs={shareIntervalMs}
          onSelect={(intervalMs) => void setShareInterval(intervalMs)}
        />
      </View>

      <View style={styles.section}>
        <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
          APP
        </ThemedText>
        <AuthorIdRow authorId={snapshot?.self?.endpointId ?? null} />
        <AppProvenanceDetails />
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
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  close: {
    alignItems: 'center',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  section: {
    gap: Spacing.two,
  },
  sectionLabel: {
    letterSpacing: 1,
  },
});
