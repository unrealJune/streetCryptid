import { useRef } from 'react';
import { Pressable, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing, type CryptidChrome } from '@/constants/theme';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { useTheme } from '@/hooks/use-theme';

import {
  permissionStepCanDecline,
  type PermissionJourneyRow,
  type PermissionOutcome,
  type PermissionPlatform,
  type PermissionStepId,
} from '../core/permission-steps';

/**
 * `PermissionsGate`'s one page: every permission as a row on a journey, the one being asked open
 * with what it is for, and the button that raises the OS prompt behind it pinned underneath.
 * Answering collapses the row to its outcome and opens the next; `permissionJourney` says which
 * row is in which state.
 *
 * The open location row IS the background-location disclosure Google Play requires before the OS
 * prompt, and is what is recorded for that declaration
 * (`docs/play-store/record-location-disclosure-video.md`): keep its title, its two feature cards
 * and, off iOS, its "Turn on location" button as they are. The web drivers (`store-shots`,
 * `map-bench`, `island-preview`) find that button by its text.
 *
 * Off iOS every step offers "Not now". On iOS none does — see `permissionStepCanDecline`.
 */

interface StepCopy {
  /** The row's name, in every state. */
  readonly name: string;
  /** The heading once the row is open. */
  readonly title: string;
  readonly lede: string;
  /** One line under the name while the step is still to come. */
  readonly summary: string;
  readonly cards: readonly { label: string; body: string; tone: 'amber' | 'green' }[];
  readonly note?: (platform: PermissionPlatform) => string | null;
  /** The button off iOS, where it raises the prompt; iOS says "Continue". */
  readonly action: string;
  readonly icon: SymbolViewProps['name'];
}

const COPY: Record<PermissionStepId, StepCopy> = {
  location: {
    name: 'Location',
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
    name: 'Location all the time',
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
    name: 'Bluetooth',
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
    name: 'Local network',
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
    name: 'Notifications',
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
    name: 'Battery',
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

const NODE = 28;
const ROW_MOTION = LinearTransition.duration(240);

const OUTCOME_LABEL: Record<PermissionOutcome | 'skipped', string> = {
  allowed: 'ALLOWED',
  refused: 'NOT ALLOWED',
  asked: 'ASKED',
  declined: 'NOT NOW',
  skipped: 'SKIPPED',
};

export function PermissionJourneyScreen({
  rows,
  platform,
  busy,
  onChoice,
}: {
  rows: readonly PermissionJourneyRow[];
  platform: PermissionPlatform;
  busy: boolean;
  onChoice: Choice;
}) {
  const chrome = useChrome();
  const scroll = useRef<ScrollViewInstance>(null);
  const journeyTop = useRef(0);
  const current = rows.find((row) => row.state === 'current')?.step;
  const canDecline = permissionStepCanDecline(platform);
  const action = current && canDecline ? COPY[current].action : 'Continue';

  // Bring the open row to the top once the reader is past the first: answered rows above it are
  // one line each, but the open one can run past the fold on a short screen.
  const reveal = (index: number, y: number) => {
    if (index === 0) return;
    scroll.current?.scrollTo({
      y: Math.max(0, journeyTop.current + y - Spacing.three),
      animated: true,
    });
  };

  return (
    <SettingsPage
      kind="onboarding"
      title={rows.length > 1 ? 'A few permissions' : 'One permission'}
      subtitle="Each one says what it’s for before your phone asks. Every one is optional, and you can change any of them later in your phone’s settings."
      testID="permissions-journey"
      scrollRef={scroll}
      footerRail={
        current
          ? {
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
                icon: COPY[current].icon,
                disabled: busy,
                busy,
                color: chrome.amber,
                ink: chrome.panel,
                testID: 'permission-step-continue',
                onPress: () => onChoice(true),
              },
            }
          : undefined
      }
      footer={
        current ? (
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
        ) : undefined
      }
    >
      <View
        onLayout={(event) => {
          journeyTop.current = event.nativeEvent.layout.y;
        }}
      >
        {rows.map((row, index) => (
          <Animated.View
            key={row.step}
            layout={ROW_MOTION}
            onLayout={
              row.state === 'current'
                ? (event) => reveal(index, event.nativeEvent.layout.y)
                : undefined
            }
          >
            <JourneyRow
              row={row}
              number={index + 1}
              last={index === rows.length - 1}
              platform={platform}
            />
          </Animated.View>
        ))}
      </View>
    </SettingsPage>
  );
}

/**
 * One stop on the journey: a node on the rail (its number, then a check or a dash once answered)
 * and the step's name. The open row adds everything the step's own screen used to say.
 */
function JourneyRow({
  row,
  number,
  last,
  platform,
}: {
  row: PermissionJourneyRow;
  number: number;
  last: boolean;
  platform: PermissionPlatform;
}) {
  const chrome = useChrome();
  const theme = useTheme();
  const copy = COPY[row.step];
  const open = row.state === 'current';
  const outcome = row.state === 'done' ? row.outcome : row.state === 'skipped' ? 'skipped' : null;
  const granted = outcome === 'allowed' || outcome === 'asked';
  const note = open ? (copy.note?.(platform) ?? null) : null;

  return (
    <View
      style={[styles.row, row.state === 'skipped' && styles.dim]}
      testID={open ? `permission-step-${row.step}` : undefined}
    >
      <View style={styles.rail}>
        <View
          style={[
            styles.node,
            open
              ? { backgroundColor: chrome.amber, borderColor: chrome.amber }
              : granted
                ? { backgroundColor: chrome.green, borderColor: chrome.green }
                : { borderColor: theme.backgroundSelected },
          ]}
        >
          {outcome ? (
            <SymbolView
              name={
                granted
                  ? { ios: 'checkmark', android: 'check', web: 'check' }
                  : { ios: 'minus', android: 'remove', web: 'remove' }
              }
              size={14}
              tintColor={granted ? chrome.bg : theme.textSecondary}
            />
          ) : (
            <ThemedText type="code" style={{ color: open ? chrome.panel : theme.textSecondary }}>
              {number}
            </ThemedText>
          )}
        </View>
        {last ? null : (
          <View style={[styles.connector, { backgroundColor: theme.backgroundSelected }]} />
        )}
      </View>

      <View style={[styles.body, !last && styles.bodySpaced]}>
        <View style={styles.heading}>
          <ThemedText
            type="smallBold"
            themeColor={open ? 'text' : 'textSecondary'}
            style={styles.name}
          >
            {copy.name}
          </ThemedText>
          {outcome ? (
            <ThemedText type="code" style={{ color: granted ? chrome.green : theme.textSecondary }}>
              {OUTCOME_LABEL[outcome]}
            </ThemedText>
          ) : null}
        </View>
        {row.state === 'upcoming' ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
            {copy.summary}
          </ThemedText>
        ) : null}
        {open ? (
          <Animated.View
            entering={FadeIn.duration(220).delay(120)}
            exiting={FadeOut.duration(120)}
            style={styles.detail}
          >
            <ThemedText style={styles.title}>{copy.title}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.paragraph}>
              {copy.lede}
            </ThemedText>
            {copy.cards.map((card) => (
              <View
                key={card.label}
                style={[styles.card, { borderColor: theme.backgroundSelected }]}
              >
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
          </Animated.View>
        ) : null}
      </View>
    </View>
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
  row: { flexDirection: 'row', gap: Spacing.three },
  dim: { opacity: 0.6 },
  rail: { alignItems: 'center', width: NODE },
  node: {
    alignItems: 'center',
    borderRadius: NODE / 2,
    borderWidth: 1.5,
    height: NODE,
    justifyContent: 'center',
    width: NODE,
  },
  connector: { flex: 1, marginVertical: Spacing.one, minHeight: Spacing.three, width: 1.5 },
  body: { flex: 1, gap: Spacing.one, paddingTop: 4 },
  bodySpaced: { paddingBottom: Spacing.four },
  heading: { alignItems: 'baseline', flexDirection: 'row', gap: Spacing.two },
  name: { flex: 1 },
  detail: { gap: Spacing.three, paddingTop: Spacing.two },
  title: { fontSize: 20, fontWeight: 700, lineHeight: 26 },
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    padding: Spacing.three,
  },
  paragraph: { lineHeight: 21 },
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
