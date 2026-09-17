import { Pressable, StyleSheet, View } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
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
 * Distinct from `LocationDisclosureScreen`, which comes after onboarding, is required by Play
 * policy, states what the OS permission is used for, and carries the accept/decline that gates
 * background location. This one asks for nothing.
 *
 * The copy is product copy: keep it whole, and keep it honest about the middle of the network
 * seeing that two anonymous IDs exchanged bytes.
 */

const LEDE = 'In a minute you’ll pick how your location travels. Here’s what’s carrying it.';

const BODY = [
  'Every fix is encrypted on your phone before it leaves — individually, for each friend you share it with. Only their phones hold the keys. We can’t read where you’ve been. Not as a promise we’re making, but as a consequence of how it’s built.',
  'Mostly there’s no we in the path at all. Your phone talks to your friends’ phones directly, and the infrastructure that helps them find each other only ever handles data it can’t read. There is no streetCryptid server holding your trail — there is no streetCryptid server at all. There are no accounts either: no email, no password, nothing to spill.',
  'We built it this way because the alternative has a known ending. Anything that holds your data long enough gets breached, or acquired, or has a quarter bad enough to make selling it sound reasonable. We would rather not ask you to trust us — we’d rather not be in a position where you have to.',
  'Which is also why all of it is open, under a license that requires anyone running it as a service to publish their changes too. The encryption, the delivery routes, the code that decides what leaves your phone — all of it is readable, by you or by someone you trust more than us.',
] as const;

/**
 * The one paragraph that takes something away rather than offering it, so it gets the amber edge
 * the rest of the app uses for a caveat — and no label above it, because a heading would turn a
 * sentence written to be read into a section someone skips.
 */
const CAVEAT =
  'What we won’t tell you is that nothing at all is visible. Delivering an encrypted fix means something in the middle can see that two anonymous IDs passed data between them — that’s true of every network, and true of this one. What that data says, and where you are, stays yours. The privacy policy says what each route can see.';

const NEXT =
  'Next screen asks how you want your location to travel, and tells you what each route costs.';

const SIGNOFF = '— the streetCryptid team.';

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
      title="Where your location goes"
      subtitle={LEDE}
      testID="privacy-onboarding"
    >
      <View style={styles.body}>
        {BODY.map((paragraph) => (
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
          {CAVEAT}
        </ThemedText>
      </View>

      <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
        {NEXT}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.signoff}>
        {SIGNOFF}
      </ThemedText>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to profile"
          onPress={onBack}
          style={styles.back}
        >
          <ThemedText type="smallBold">Back</ThemedText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue to delivery"
          onPress={onContinue}
          testID="onboarding-privacy-continue"
          style={({ pressed }) => [
            styles.continue,
            { backgroundColor: chrome.green, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          <ThemedText type="smallBold" style={{ color: chrome.bg }}>
            Continue
          </ThemedText>
        </Pressable>
      </View>
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
