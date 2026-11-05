import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing, type CryptidChrome } from '@/constants/theme';
import { SettingsPage } from '@/features/settings/components/settings-page';
import { useTheme } from '@/hooks/use-theme';

import {
  permissionStepCanDecline,
  type PermissionJourneyRow,
  type PermissionPlatform,
  type PermissionStepId,
} from '../core/permission-steps';
import { PERMISSION_STEP_COPY, PERMISSIONS_PAGE_COPY } from '@/copy/permissions';

/**
 * `PermissionsGate`'s one page: every permission as a row on a journey, the one being asked open
 * with what it is for, and the button that raises the OS prompt behind it pinned underneath.
 * Answering collapses the row to its outcome and opens the next; `permissionJourney` says which
 * row is in which state.
 *
 * Every word on the page is in `src/copy/permissions.md` (regenerate with `just copy`). The open
 * location row IS the background-location disclosure Google Play requires before the OS prompt,
 * and is what is recorded for that declaration (`docs/play-store/record-location-disclosure-video.md`):
 * keep its title, its two feature cards and, off iOS, its "Turn on location" button as they are.
 * The web drivers (`store-shots`, `map-bench`, `island-preview`) find that button by its text.
 *
 * Off iOS every step offers "Not now". On iOS none does — see `permissionStepCanDecline`.
 */

/** The step's icon on the primary button. Its words are in `src/copy/permissions.md`. */
const STEP_ICON: Record<PermissionStepId, SymbolViewProps['name']> = {
  location: { ios: 'location.fill', android: 'my_location', web: 'my_location' },
  'background-location': {
    ios: 'location.circle',
    android: 'share_location',
    web: 'share_location',
  },
  bluetooth: { ios: 'antenna.radiowaves.left.and.right', android: 'bluetooth', web: 'bluetooth' },
  'local-network': { ios: 'wifi', android: 'wifi', web: 'wifi' },
  notifications: { ios: 'bell', android: 'notifications', web: 'notifications' },
  battery: { ios: 'battery.100', android: 'battery_full', web: 'battery_full' },
};

type Choice = (allow: boolean) => void;

const NODE = 28;
/**
 * One answer closes a row and opens the next in a single motion on the UI thread: each row's
 * detail animates its own height (see `Disclosure`), so what one row gives up the next takes and
 * the rows below barely move. Entering/exiting animations plus a layout transition did this in
 * three uncoordinated pieces — the open row grew empty and filled in late, the closing row's text
 * overlapped its neighbour while it faded, and a scroll on every layout raced both.
 */
const DISCLOSURE_MS = 300;
const DISCLOSURE_EASING = Easing.bezier(0.2, 0, 0, 1);

const PAGE = PERMISSIONS_PAGE_COPY;
const COPY = PERMISSION_STEP_COPY;

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
  const rowTops = useRef<Partial<Record<PermissionStepId, number>>>({});
  const offset = useRef(0);
  const current = rows.find((row) => row.state === 'current')?.step;
  const canDecline = permissionStepCanDecline(platform);
  const action = current && canDecline ? COPY[current].action : PAGE.continue;

  // Once a row has finished opening, bring its top back into view if the reader was scrolled past
  // it — reading to the bottom of a long row and answering collapses the content above them.
  // After the motion, never during it: a scroll racing a height animation is what looked janky.
  const settle = (step: PermissionStepId) => {
    const top = journeyTop.current + (rowTops.current[step] ?? 0) - Spacing.three;
    if (offset.current > top) scroll.current?.scrollTo({ y: Math.max(0, top), animated: true });
  };

  return (
    <SettingsPage
      kind="onboarding"
      title={rows.length > 1 ? PAGE.title : PAGE.titleSingle}
      subtitle={PAGE.subtitle}
      testID="permissions-journey"
      scrollRef={scroll}
      onScrollOffset={(y) => {
        offset.current = y;
      }}
      footerRail={
        current
          ? {
              back: canDecline
                ? {
                    label: PAGE.notNow,
                    icon: { ios: 'xmark', android: 'close', web: 'close' },
                    disabled: busy,
                    testID: 'permission-step-skip',
                    onPress: () => onChoice(false),
                  }
                : undefined,
              primary: {
                label: action,
                railLabel: PAGE.railOk,
                icon: STEP_ICON[current],
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
                  {PAGE.notNow}
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
          <View
            key={row.step}
            onLayout={(event) => {
              rowTops.current[row.step] = event.nativeEvent.layout.y;
            }}
          >
            <JourneyRow
              row={row}
              number={index + 1}
              last={index === rows.length - 1}
              platform={platform}
              onOpened={() => settle(row.step)}
            />
          </View>
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
  onOpened,
}: {
  row: PermissionJourneyRow;
  number: number;
  last: boolean;
  platform: PermissionPlatform;
  onOpened: () => void;
}) {
  const chrome = useChrome();
  const theme = useTheme();
  const copy = COPY[row.step];
  const open = row.state === 'current';
  const outcome = row.state === 'done' ? row.outcome : row.state === 'skipped' ? 'skipped' : null;
  const granted = outcome === 'allowed' || outcome === 'asked';
  const note = copy.note[platform] ?? copy.note.default ?? null;

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
            <Animated.View entering={FadeIn.duration(DISCLOSURE_MS)}>
              <ThemedText
                type="code"
                style={{ color: granted ? chrome.green : theme.textSecondary }}
              >
                {PAGE.outcome[outcome]}
              </ThemedText>
            </Animated.View>
          ) : null}
        </View>
        <Disclosure open={row.state === 'upcoming'}>
          <ThemedText type="small" themeColor="textSecondary" style={styles.summary}>
            {copy.summary}
          </ThemedText>
        </Disclosure>
        <Disclosure open={open} onOpened={onOpened}>
          <View style={styles.detail}>
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
          </View>
        </Disclosure>
      </View>
    </View>
  );
}

/**
 * Content that opens and closes by animating its height between 0 and its measured height, the
 * text fading in over the second half of an opening and out over the first half of a closing, so
 * it is never seen squashed. While animating, the content is laid out absolutely inside a clipping
 * box, which is what lets it measure at full height while the box is still shut.
 *
 * Content open at mount is shown in place, unanimated (the page opening is its entrance). It stays
 * mounted only while open or closing, and reduced motion gets the end state at once.
 */
function Disclosure({
  open,
  onOpened,
  children,
}: {
  open: boolean;
  onOpened?: () => void;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  // In normal flow until it first animates, so what is open at mount needs no measuring frame.
  const [inFlow, setInFlow] = useState(open);
  const height = useSharedValue(0);
  const progress = useSharedValue(open ? 1 : 0);
  const opened = useRef(onOpened);
  useEffect(() => {
    opened.current = onOpened;
  });
  // A change of `open` is adjusted during render (React's pattern for state that follows a prop):
  // opening mounts the content at once so the effect below has something to grow.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    setInFlow(false);
    if (open || reducedMotion) setMounted(open);
  }

  const animated = useRef(open);
  useEffect(() => {
    if (animated.current === open) return;
    animated.current = open;
    const notifyOpened = () => opened.current?.();
    if (reducedMotion) {
      progress.value = open ? 1 : 0;
      if (open) notifyOpened();
      return;
    }
    progress.value = withTiming(
      open ? 1 : 0,
      { duration: DISCLOSURE_MS, easing: DISCLOSURE_EASING },
      (finished) => {
        if (!finished) return;
        if (open) scheduleOnRN(notifyOpened);
        else scheduleOnRN(setMounted, false);
      }
    );
  }, [open, reducedMotion, progress]);

  const box = useAnimatedStyle(() => ({ height: height.value * progress.value }));
  const fade = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.45, 1], [0, 1], 'clamp'),
  }));

  if (!mounted) return null;
  return (
    <Animated.View style={[styles.disclosure, !inFlow && box]}>
      <Animated.View
        style={[!inFlow && styles.disclosureContent, fade]}
        onLayout={(event) => {
          height.value = event.nativeEvent.layout.height;
        }}
      >
        {children}
      </Animated.View>
    </Animated.View>
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
  body: { flex: 1, paddingTop: 4 },
  bodySpaced: { paddingBottom: Spacing.four },
  heading: { alignItems: 'baseline', flexDirection: 'row', gap: Spacing.two },
  name: { flex: 1 },
  summary: { lineHeight: 21, paddingTop: Spacing.one },
  detail: { gap: Spacing.three, paddingTop: Spacing.three },
  disclosure: { overflow: 'hidden' },
  disclosureContent: { left: 0, position: 'absolute', right: 0, top: 0 },
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
