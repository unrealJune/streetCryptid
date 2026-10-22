import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Android only: asks for "Unrestricted" battery use, right after background location is granted.
 *
 * Why it exists: on 2026-10-21 a Pixel 10's sharing stopped for 8.5 hours. Android reclaimed the
 * process, tried to bring the location service back, and refused to let it become a foreground
 * service because the app was in the background — the rule every optimised app lives under. An
 * app exempt from battery optimisation is allowed that restart, so the gap closes on its own. The
 * same week had six more gaps of 2.7–25.9 hours, each ended only by someone opening the app.
 *
 * The copy says what goes wrong without it in the user's terms (friends see a stale dot) and does
 * not overclaim the battery cost: the service's sampling is unchanged by the exemption, it only
 * stops Android from killing it for good.
 *
 * Gated by `BackgroundReliabilityGate`. Seen once; "Not now" is a real choice, and the resume
 * notification `ServiceRecovery` posts covers a phone that stays optimised.
 */
export function BackgroundReliabilityScreen({
  onAllow,
  onSkip,
}: {
  onAllow: () => void;
  onSkip: () => void;
}) {
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
      testID="background-reliability-onboarding"
    >
      <View style={styles.header}>
        <ThemedText style={styles.title}>Keep sharing when the app is closed</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Android sometimes stops apps in the background to save memory. When it stops
          streetCryptid, it won&apos;t let sharing start again until you open the app — so your
          friends see a dot that stopped hours ago.
        </ThemedText>
      </View>

      <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
        <ThemedText type="smallBold" style={{ color: chrome.green }}>
          SET BATTERY USE TO UNRESTRICTED
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.cardBody}>
          This lets streetCryptid restart sharing by itself. It doesn&apos;t make the app check your
          location any more often — it only stops Android from switching sharing off for good.
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it,
        we&apos;ll send a notification whenever sharing stops so you can turn it back on.
      </ThemedText>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Not now"
          onPress={onSkip}
          testID="background-reliability-skip"
          style={styles.back}
        >
          <ThemedText type="smallBold">Not now</ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Allow unrestricted battery use"
          onPress={onAllow}
          testID="background-reliability-allow"
          style={({ pressed }) => [
            styles.continue,
            { backgroundColor: chrome.green, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          <ThemedText type="smallBold" style={{ color: chrome.bg }}>
            Allow
          </ThemedText>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: Spacing.four, paddingHorizontal: Spacing.four },
  header: { gap: Spacing.three },
  title: { fontSize: 28, fontWeight: '700', lineHeight: 34 },
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    padding: Spacing.three,
  },
  cardBody: { lineHeight: 21 },
  actions: { flexDirection: 'row', gap: Spacing.three },
  back: { justifyContent: 'center', padding: Spacing.three },
  continue: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    padding: Spacing.three,
  },
});
