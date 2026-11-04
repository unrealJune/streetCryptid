import { Pressable, StyleSheet, View } from 'react-native';
import type { SymbolViewProps } from 'expo-symbols';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing, type CryptidChrome } from '@/constants/theme';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { useTheme } from '@/hooks/use-theme';

import {
  permissionStepCanDecline,
  type PermissionPlatform,
  type PermissionStepId,
} from '../core/permission-steps';

/**
 * One screen of `PermissionsGate`: the overview, or a single permission with what it is for and
 * the button that raises the OS prompt behind it.
 *
 * The location step IS the background-location disclosure Google Play requires before the OS
 * prompt, and is the screen recorded for that declaration
 * (`docs/play-store/record-location-disclosure-video.md`): keep its title, its two feature cards
 * and, off iOS, its "Turn on location" button as they are. The web drivers (`store-shots`,
 * `map-bench`, `island-preview`) find that button by its text.
 *
 * Off iOS every step offers "Not now". On iOS none does — see `permissionStepCanDecline`.
 */

interface StepCopy {
  readonly title: string;
  readonly lede: string;
  /** One line for the overview. */
  readonly summary: string;
  readonly cards: readonly { label: string; body: string; tone: 'amber' | 'green' }[];
  readonly note?: (platform: PermissionPlatform) => string | null;
  /** The button off iOS, where it raises the prompt; iOS says "Continue". */
  readonly action: string;
  readonly icon: SymbolViewProps['name'];
}

const COPY: Record<PermissionStepId, StepCopy> = {
  location: {
    title: 'Before we turn on location',
    lede: 'streetCryptid uses your location — including while the app is closed or in the background — for two things. Here’s exactly what and why.',
    summary: 'Location — to reveal the streets you walk and share your position with friends.',
    cards: [
      {
        label: 'TERRITORY EXPLORATION',
        tone: 'amber',
        body: 'As you walk through your city, streetCryptid reveals the streets and hex-shaped sectors you’ve actually covered — building your personal explored map. This only works if the app can sample your location occasionally in the background, since most of your walking happens while the app is closed.',
      },
      {
        label: 'FRIEND LOCATION SHARING',
        tone: 'green',
        body: 'If you pair with friends, your live location syncs directly to their devices — end-to-end encrypted — so they can see you on the map, including while the app is in the background. Only friends you’ve explicitly paired with can see this.',
      },
    ],
    note: (platform) =>
      platform === 'ios'
        ? 'Next, your iPhone will ask to allow location access. The step after this one asks for background access.'
        : 'Next, your device will ask you to allow location access, and the step after this one asks for “Allow all the time.” Choosing “Not now” keeps streetCryptid working, minus background exploration and friend sharing — you can turn it on later from Settings.',
    action: 'Turn on location',
    icon: { ios: 'location.fill', android: 'my_location', web: 'my_location' },
  },
  'background-location': {
    title: 'Allow all the time',
    lede: 'Most of your walking happens with the app closed. Background access is what lets streetCryptid keep up then.',
    summary: 'Location all the time — so it keeps working while the app is closed.',
    cards: [
      {
        label: 'WHILE THE APP IS CLOSED',
        tone: 'green',
        body: 'With “all the time,” your explored map keeps filling in and friends keep seeing where you are while your phone is in your pocket. With “only while using the app,” both stop the moment you leave it, and friends see a dot that stopped where you were.',
      },
    ],
    note: (platform) =>
      platform === 'ios'
        ? 'Next, your iPhone will ask whether to change to “Always Allow.”'
        : platform === 'android'
          ? 'Android opens Settings for this one: choose “Allow all the time,” then come back.'
          : null,
    action: 'Allow all the time',
    icon: { ios: 'location.circle', android: 'share_location', web: 'share_location' },
  },
  bluetooth: {
    title: 'Bluetooth, for Bump',
    lede: 'Bump pairs two phones held together, with no link to send and no account to look up.',
    summary: 'Bluetooth — to find a friend’s phone when you Bump.',
    cards: [
      {
        label: 'PAIRING IN PERSON',
        tone: 'green',
        body: 'When you both tap Bump, each phone finds the other over Bluetooth and starts an encrypted pairing on the spot — it works with no signal at all. Without Bluetooth you can still pair by sending a link.',
      },
    ],
    note: (platform) =>
      platform === 'android'
        ? 'Android calls this “Nearby devices.”'
        : platform === 'ios'
          ? 'Next, your iPhone will ask to allow Bluetooth.'
          : null,
    action: 'Allow Bluetooth',
    icon: { ios: 'antenna.radiowaves.left.and.right', android: 'bluetooth', web: 'bluetooth' },
  },
  'local-network': {
    title: 'Phones on your Wi-Fi',
    lede: 'When a friend is on the same Wi-Fi, your phones can talk to each other directly.',
    summary: 'Local network — to reach friends on the same Wi-Fi directly.',
    cards: [
      {
        label: 'THE SHORT WAY ROUND',
        tone: 'green',
        body: 'Directly is faster than going through a relay, and it keeps working when the internet doesn’t. Without it nothing breaks — your location still reaches friends, just the long way.',
      },
    ],
    note: (platform) =>
      platform === 'ios'
        ? 'Next, your iPhone will ask to find and connect to devices on your local network.'
        : null,
    action: 'Allow local network',
    icon: { ios: 'wifi', android: 'wifi', web: 'wifi' },
  },
  notifications: {
    title: 'A notification while sharing',
    lede: 'Android shows a notification for as long as streetCryptid shares your location in the background.',
    summary: 'Notifications — so you can always see that sharing is on.',
    cards: [
      {
        label: 'ALWAYS VISIBLE',
        tone: 'amber',
        body: 'It’s how you can tell at a glance that sharing is on, and if Android ever stops it, it’s how we let you know. Sharing works either way; without this you just can’t see it.',
      },
    ],
    action: 'Allow notifications',
    icon: { ios: 'bell', android: 'notifications', web: 'notifications' },
  },
  battery: {
    title: 'Keep sharing when the app is closed',
    lede: 'Android sometimes stops apps in the background to save memory. When it stops streetCryptid, it won’t let sharing start again until you open the app — so your friends see a dot that stopped hours ago.',
    summary: 'Unrestricted battery use — so Android can’t switch sharing off for good.',
    cards: [
      {
        label: 'SET BATTERY USE TO UNRESTRICTED',
        tone: 'green',
        body: 'This lets streetCryptid restart sharing by itself. It doesn’t make the app check your location any more often — it only stops Android from switching sharing off for good.',
      },
    ],
    note: () =>
      'You can change this any time in Settings → Apps → streetCryptid → Battery. If you skip it, we’ll send a notification whenever sharing stops so you can turn it back on.',
    action: 'Allow',
    icon: { ios: 'battery.100', android: 'battery_full', web: 'battery_full' },
  },
};

type Choice = (allow: boolean) => void;

export function PermissionIntroScreen({
  steps,
  onContinue,
}: {
  steps: readonly PermissionStepId[];
  onContinue: () => void;
}) {
  const chrome = useChrome();
  const theme = useTheme();
  return (
    <SettingsPage
      kind="onboarding"
      title="A few permissions"
      subtitle="Each one gets its own screen saying what it’s for, before your phone asks. Here’s what’s coming."
      testID="permissions-intro"
      footerRail={{
        primary: {
          label: 'Continue',
          railLabel: 'Next',
          icon: { ios: 'chevron.right', android: 'arrow_forward', web: 'arrow_forward' },
          color: chrome.green,
          ink: chrome.bg,
          testID: 'permission-intro-continue',
          onPress: onContinue,
        },
      }}
      footer={
        <PrimaryButton
          label="Continue"
          color={chrome.green}
          ink={chrome.bg}
          testID="permission-intro-continue"
          onPress={onContinue}
        />
      }
    >
      <View style={styles.list}>
        {steps.map((step, index) => (
          <View
            key={step}
            style={[styles.listRow, { borderColor: theme.backgroundSelected }]}
            accessible
          >
            <ThemedText type="code" style={{ color: chrome.amber }}>
              {String(index + 1).padStart(2, '0')}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.listBody}>
              {COPY[step].summary}
            </ThemedText>
          </View>
        ))}
      </View>
      <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
        Every one is optional, and every one can be changed later in your phone’s settings.
      </ThemedText>
    </SettingsPage>
  );
}

export function PermissionStepScreen({
  step,
  platform,
  position,
  busy,
  onChoice,
}: {
  step: PermissionStepId;
  platform: PermissionPlatform;
  /** `[index, total]`, 1-based, or `null` for a run of one step. */
  position: readonly [number, number] | null;
  busy: boolean;
  onChoice: Choice;
}) {
  const chrome = useChrome();
  const theme = useTheme();
  const copy = COPY[step];
  const canDecline = permissionStepCanDecline(platform);
  const action = canDecline ? copy.action : 'Continue';
  const note = copy.note?.(platform) ?? null;

  return (
    <SettingsPage
      kind="onboarding"
      title={copy.title}
      subtitle={copy.lede}
      testID={`permission-step-${step}`}
      footerRail={{
        back: canDecline
          ? {
              label: 'Not now',
              icon: { ios: 'xmark', android: 'close', web: 'close' },
              disabled: busy,
              testID: 'permission-step-skip',
              onPress: () => onChoice(false),
            }
          : undefined,
        primary: {
          label: action,
          railLabel: 'OK',
          icon: copy.icon,
          disabled: busy,
          busy,
          color: chrome.amber,
          ink: chrome.panel,
          testID: 'permission-step-continue',
          onPress: () => onChoice(true),
        },
      }}
      footer={
        <View style={styles.actions}>
          <PrimaryButton
            label={action}
            color={chrome.amber}
            ink={chrome.panel}
            disabled={busy}
            testID="permission-step-continue"
            onPress={() => onChoice(true)}
          />
          {canDecline ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onChoice(false)}
              testID="permission-step-skip"
              style={({ pressed }) => [styles.secondary, { opacity: pressed || busy ? 0.58 : 1 }]}
            >
              <ThemedText type="small" themeColor="textSecondary">
                Not now
              </ThemedText>
            </Pressable>
          ) : null}
        </View>
      }
    >
      {position ? (
        <ThemedText type="code" themeColor="textSecondary" style={styles.position}>
          {`STEP ${position[0]} OF ${position[1]}`}
        </ThemedText>
      ) : null}
      {copy.cards.map((card) => (
        <View key={card.label} style={[styles.card, { borderColor: theme.backgroundSelected }]}>
          <ThemedText type="smallBold" style={{ color: chrome[card.tone] }}>
            {card.label}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
            {card.body}
          </ThemedText>
        </View>
      ))}
      {note ? (
        <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
          {note}
        </ThemedText>
      ) : null}
    </SettingsPage>
  );
}

function PrimaryButton({
  label,
  color,
  ink,
  disabled = false,
  testID,
  onPress,
}: {
  label: string;
  color: string;
  ink: string;
  disabled?: boolean;
  testID: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: color, opacity: disabled ? 0.4 : pressed ? 0.72 : 1 },
      ]}
    >
      <ThemedText style={[styles.primaryText, { color: ink }]}>{label}</ThemedText>
    </Pressable>
  );
}

function useChrome(): CryptidChrome {
  const scheme = useColorScheme();
  return CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
}

const styles = StyleSheet.create({
  position: { letterSpacing: 1 },
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  paragraph: { lineHeight: 21 },
  list: { gap: Spacing.two },
  listRow: {
    alignItems: 'baseline',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  listBody: { flex: 1, lineHeight: 21 },
  actions: { gap: Spacing.two },
  primary: {
    alignItems: 'center',
    borderRadius: 12,
    justifyContent: 'center',
    minHeight: 54,
    paddingHorizontal: Spacing.three,
  },
  primaryText: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
  secondary: { alignItems: 'center', justifyContent: 'center', minHeight: 44 },
});
