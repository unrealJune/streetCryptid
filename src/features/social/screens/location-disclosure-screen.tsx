import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Prominent, in-app disclosure shown once, before the OS runtime permission prompt for
 * ACCESS_BACKGROUND_LOCATION — required by Google Play policy for apps that use background
 * location (see the "Location permissions" declaration in Play Console). This screen is the thing
 * that gets screen-recorded for that declaration's required video.
 *
 * Gated by `LocationDisclosureGate`, which reads `disclosureStatus` off `useLocationSharing()`.
 * "Turn on location" persists the choice and proceeds to request the OS permission; "Not now"
 * persists a decline and lets the person use the app without background location — they can turn
 * it on later from Settings.
 */
export function LocationDisclosureScreen({ onChoice }: { onChoice: (accepted: boolean) => void }) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + Spacing.five, paddingBottom: insets.bottom + Spacing.four },
      ]}
    >
      <View style={styles.header}>
        <ThemedText style={styles.title}>Before we turn on location</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          streetCryptid uses your location — including while the app is closed or in the background
          — for two things. Here&apos;s exactly what and why.
        </ThemedText>
      </View>

      <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={{ color: chrome.amber }}>
          TERRITORY EXPLORATION
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.cardBody}>
          As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors
          you&apos;ve actually covered — building your personal explored map. This only works if the
          app can sample your location occasionally in the background, since most of your walking
          happens while the app is closed.
        </ThemedText>
      </View>

      <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={{ color: chrome.green }}>
          FRIEND LOCATION SHARING
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.cardBody}>
          If you pair with friends, your live location syncs directly to their devices — end-to-end
          encrypted — so they can see you on the map, including while the app is in the background.
          Only friends you&apos;ve explicitly paired with can see this.
        </ThemedText>
      </View>

      <View style={styles.footerCopy}>
        <ThemedText type="small" themeColor="textSecondary">
          Next, your device will ask you to allow location access, including &quot;Allow all the
          time.&quot; Choosing &quot;Not now&quot; keeps streetCryptid working, minus background
          exploration and friend sharing — you can turn it on later from Settings.
        </ThemedText>
      </View>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => onChoice(true)}
          style={({ pressed }) => [
            styles.primaryButton,
            { backgroundColor: chrome.amber, opacity: pressed ? 0.72 : 1 },
          ]}
        >
          <ThemedText style={[styles.primaryButtonText, { color: chrome.panel }]}>
            Turn on location
          </ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onChoice(false)}
          style={({ pressed }) => [styles.secondaryButton, { opacity: pressed ? 0.58 : 1 }]}
        >
          <ThemedText type="small" themeColor="textSecondary">
            Not now
          </ThemedText>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.four,
    paddingHorizontal: Spacing.four,
  },
  header: {
    gap: Spacing.two,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
  },
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  cardBody: {
    lineHeight: 20,
  },
  footerCopy: {
    paddingTop: Spacing.one,
  },
  actions: {
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
  },
  secondaryButton: {
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
});
