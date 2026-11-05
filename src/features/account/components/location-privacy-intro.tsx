import { Pressable, StyleSheet, View } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { ONBOARDING_COPY } from '@/copy/onboarding';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { SettingsPage } from '@/features/settings/components/settings-page';

/**
 * The first-run explanation of where a location fix actually goes, shown once, between the persona
 * step and the delivery step of `AccountOnboardingScreen`.
 *
 * It sits there rather than at the very front because its last line is a promise about the NEXT
 * screen: the delivery picker is where a route is chosen and where each route's cost is stated, and
 * this is the context someone needs to read that picker as a real choice rather than two words they
 * have no basis to pick between. It is not a gate and stores nothing of its own — the profile is
 * the completed-onboarding marker (see `finish()` there), so this is seen exactly once per install
 * and replayed in full if setup is abandoned halfway.
 *
 * Distinct from the location step of `PermissionsGate`, which comes after onboarding, is required
 * by Play policy, states what the OS permission is used for, and carries the accept/decline that
 * gates background location. This one asks for nothing.
 *
 * The copy is product copy (`src/copy/onboarding.md`): keep it whole, and keep it honest about the middle of the network
 * seeing that two anonymous IDs exchanged bytes.
 */

/** The words are in `src/copy/onboarding.md`, the letter's paragraphs separated by blank lines. */
const COPY = ONBOARDING_COPY.privacy;
const LETTER = COPY.letter.split('\n\n');

export function LocationPrivacyIntro({
  onBack,
  onContinue,
}: {
  onBack: () => void;
  onContinue: () => void;
}) {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  return (
    <SettingsPage
      kind="onboarding"
      title={COPY.title}
      subtitle={COPY.lede}
      testID="privacy-onboarding"
      footerRail={{
        back: {
          label: COPY.back,
          accessibilityLabel: COPY.backLabel,
          icon: { ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' },
          onPress: onBack,
        },
        primary: {
          label: COPY.continue,
          railLabel: COPY.railContinue,
          accessibilityLabel: COPY.continueLabel,
          icon: { ios: 'chevron.right', android: 'arrow_forward', web: 'arrow_forward' },
          color: chrome.green,
          ink: chrome.bg,
          testID: 'onboarding-privacy-continue',
          onPress: onContinue,
        },
      }}
      footer={
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={COPY.backLabel}
            onPress={onBack}
            style={styles.back}
          >
            <ThemedText type="smallBold">{COPY.back}</ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={COPY.continueLabel}
            onPress={onContinue}
            testID="onboarding-privacy-continue"
            style={({ pressed }) => [
              styles.continue,
              { backgroundColor: chrome.green, opacity: pressed ? 0.65 : 1 },
            ]}
          >
            <ThemedText type="smallBold" style={{ color: chrome.bg }}>
              {COPY.continue}
            </ThemedText>
          </Pressable>
        </View>
      }
    >
      <View style={styles.body}>
        {LETTER.map((paragraph) => (
          <ThemedText
            key={paragraph.slice(0, 32)}
            type="small"
            themeColor="textSecondary"
            style={styles.paragraph}
          >
            {paragraph}
          </ThemedText>
        ))}
      </View>

      <View style={[styles.card, { borderColor: chrome.amber }]}>
        <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
          {COPY.caveat}
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
        {COPY.next}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.signoff}>
        {COPY.signoff}
      </ThemedText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  // Tighter than the page's own section rhythm: these are paragraphs of one argument, not
  // separate sections of a settings page.
  body: { gap: Spacing.three },
  paragraph: { lineHeight: 21 },
  signoff: { lineHeight: 21, opacity: 0.8 },
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
  },
  actions: { flexDirection: 'row', gap: Spacing.three },
  back: { justifyContent: 'center', padding: Spacing.three },
  continue: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    padding: Spacing.three,
  },
});
