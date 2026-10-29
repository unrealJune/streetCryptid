import { type ReactNode, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ScrollViewInstance } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { useSystemRail } from '@/hooks/use-system-rail';
import { useTheme } from '@/hooks/use-theme';

interface SettingsPageProps {
  readonly title: string;
  readonly testID?: string;
  readonly subtitle?: string;
  /**
   * `root` is the menu itself: it owns the sheet, so it closes it. `sub` is one
   * menu deep and pops back to the menu instead.
   */
  readonly kind?: 'root' | 'sub' | 'onboarding';
  readonly backLabel?: string;
  /**
   * Actions pinned under the scroll, always on screen. Onboarding steps put Back / Continue here:
   * at the end of the scroll they sat below the fold on any short window, and a landscape
   * foldable is ~670 pt tall.
   */
  readonly footer?: ReactNode;
  /** The footer's actions as rail buttons, used instead of `footer` beside a system rail. */
  readonly footerRail?: FooterRail;
  readonly children: ReactNode;
}

/**
 * The one page chrome every Settings route wears: safe-area padding, the centered
 * max-width column, the title block, and exactly one dismissal affordance.
 *
 * Settings is a sheet pulled over the map with no tab bar and no native header
 * (`headerShown: false` all the way down), so the escape hatch has to be drawn
 * here. Which one you get is the whole difference between the two kinds: the root
 * menu shows ✕ and dismisses the sheet, a submenu shows ‹ SETTINGS and pops one
 * level. Maestro keys on those two accessibility labels — see
 * `.maestro/pairing/close-settings.yaml`.
 */
export function SettingsPage({
  title,
  testID,
  subtitle,
  kind = 'sub',
  backLabel = 'Settings',
  footer,
  footerRail,
  children,
}: SettingsPageProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const railed = useSystemRail() > 0 && footerRail !== undefined;
  const router = useRouter();
  const scroll = useRef<ScrollViewInstance>(null);

  // A page whose first screen is one tall element (Delivery's preview) gives no hint that there is
  // more below it, so show the scroll bar once as it opens. iOS only flashes it when it can scroll.
  useEffect(() => {
    const timer = setTimeout(() => scroll.current?.flashScrollIndicators(), FLASH_SCROLL_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const page = (
    <ScrollView
      ref={scroll}
      testID={testID}
      style={{
        backgroundColor: theme.background,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + Spacing.four,
          paddingBottom: footer && !railed ? Spacing.four : insets.bottom + Spacing.six,
        },
      ]}
    >
      {kind === 'sub' ? (
        <Pressable
          accessibilityLabel={`Back to ${backLabel.toLowerCase()}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.back()}
          style={({ pressed }) => [styles.back, { opacity: pressed ? 0.55 : 1 }]}
        >
          <SymbolView
            name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
            size={15}
            tintColor={theme.textSecondary}
          />
          <ThemedText themeColor="textSecondary" style={styles.backLabel}>
            {backLabel.toUpperCase()}
          </ThemedText>
        </Pressable>
      ) : null}

      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <ThemedText style={styles.title}>{title.toUpperCase()}</ThemedText>
          {subtitle ? (
            <ThemedText type="small" themeColor="textSecondary">
              {subtitle}
            </ThemedText>
          ) : null}
        </View>
        {kind === 'root' ? (
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
        ) : null}
      </View>

      {children}
    </ScrollView>
  );

  if (!footer) return page;
  return (
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
      {page}
      <PageFooter rail={footerRail}>{footer}</PageFooter>
    </View>
  );
}

/**
 * A full-screen page's actions, pinned under its scroll in the same centred column, above the
 * bottom inset. The hairline is what says the text above continues behind it.
 */
export function PageFooter({
  maxWidth = MaxContentWidth,
  rail,
  children,
}: {
  /** Match the column above when it is narrower than a settings page's. */
  readonly maxWidth?: number;
  /** The same actions as round buttons, stacked in a system rail when the window has one. */
  readonly rail?: FooterRail;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const railWidth = useSystemRail();

  if (rail && railWidth > 0) {
    // In the rail, bottom first: the primary action sits where a thumb rests and a bar's would
    // have been, with Back above it. The page gets the bar's height back.
    return (
      <View
        pointerEvents="box-none"
        style={[styles.rail, { bottom: Math.max(insets.bottom, Spacing.three), width: railWidth }]}
      >
        {rail.back ? <RailButton action={rail.back} /> : null}
        <RailPrimary action={rail.primary} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: theme.background,
          borderColor: theme.backgroundSelected,
          paddingBottom: Math.max(insets.bottom, Spacing.three),
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <View style={[styles.footerColumn, { maxWidth }]}>{children}</View>
    </View>
  );
}

export interface RailAction {
  /** Shown under the button: an icon alone does not say "Turn on location". */
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly icon: SymbolViewProps['name'];
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly testID?: string;
  /** Fill and glyph colour of a primary button. */
  readonly color?: string;
  readonly ink?: string;
}

export interface FooterRail {
  readonly back?: RailAction;
  readonly primary: RailAction;
}

/**
 * The primary action as a tall pill that fills the rail, its label running down it like a book
 * spine: the rail is too narrow to set "Continue" across, and a round button with a caption under
 * it read as an afterthought next to the page it finishes.
 */
function RailPrimary({ action }: { action: RailAction }) {
  const theme = useTheme();
  const fill = action.color ?? theme.text;
  const ink = action.ink ?? theme.background;
  return (
    <Pressable
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: action.disabled, busy: action.busy }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.railPrimary,
        { backgroundColor: fill, opacity: action.disabled ? 0.4 : pressed ? 0.65 : 1 },
      ]}
      testID={action.testID}
    >
      {/* Laid out horizontally at the pill's height, then turned; a rotated view keeps its
          unrotated layout box, so the box is sized and centred by hand. */}
      <View pointerEvents="none" style={styles.railSpine}>
        <ThemedText numberOfLines={1} style={[styles.railSpineLabel, { color: ink }]}>
          {action.label}
        </ThemedText>
      </View>
      <SymbolView name={action.icon} size={22} tintColor={ink} />
    </Pressable>
  );
}

function RailButton({ action }: { action: RailAction }) {
  const theme = useTheme();
  const fill = 'transparent';
  const ink = theme.text;
  return (
    <Pressable
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: action.disabled, busy: action.busy }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => [
        styles.railAction,
        { opacity: action.disabled ? 0.4 : pressed ? 0.65 : 1 },
      ]}
      testID={action.testID}
    >
      <View
        style={[
          styles.railButton,
          { backgroundColor: fill, borderColor: theme.backgroundSelected },
        ]}
      >
        <SymbolView name={action.icon} size={22} tintColor={ink} />
      </View>
      <ThemedText type="smallBold" style={styles.railLabel} numberOfLines={2}>
        {action.label}
      </ThemedText>
    </Pressable>
  );
}

const RAIL_PRIMARY_WIDTH = 60;
const RAIL_PRIMARY_HEIGHT = 240;
const RAIL_SPINE_LINE = 20;
/** The pill's height less the arrow at its foot and the padding at both ends. */
const RAIL_SPINE_LENGTH = RAIL_PRIMARY_HEIGHT - 22 - Spacing.three * 3;

/** After the push animation, or the flash plays under it. */
const FLASH_SCROLL_DELAY_MS = 450;

/** A labelled group of rows inside a {@link SettingsPage}. */
export function SettingsSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  const theme = useTheme();

  return (
    <View style={styles.section}>
      {/* The rule is the section, not the word above it. It is what separates one group
          of rows from the next on a page whose rows are already hairline-separated, and
          it is the device the design reference uses under IDENTITY / LOCATION. */}
      <View style={[styles.sectionRule, { borderColor: theme.backgroundSelected }]}>
        <ThemedText themeColor="textSecondary" style={styles.sectionLabel}>
          {label.toUpperCase()}
        </ThemedText>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.three,
  },
  rail: {
    alignItems: 'center',
    gap: Spacing.three,
    position: 'absolute',
    right: 0,
  },
  railAction: {
    alignItems: 'center',
    gap: Spacing.one,
  },
  railButton: {
    alignItems: 'center',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  railPrimary: {
    alignItems: 'center',
    borderRadius: RAIL_PRIMARY_WIDTH / 2,
    height: RAIL_PRIMARY_HEIGHT,
    justifyContent: 'flex-end',
    paddingBottom: Spacing.three,
    width: RAIL_PRIMARY_WIDTH,
  },
  railSpine: {
    alignItems: 'center',
    height: RAIL_SPINE_LINE,
    justifyContent: 'center',
    left: (RAIL_PRIMARY_WIDTH - RAIL_SPINE_LENGTH) / 2,
    position: 'absolute',
    top: (RAIL_SPINE_LENGTH - RAIL_SPINE_LINE) / 2 + Spacing.three,
    transform: [{ rotate: '90deg' }],
    width: RAIL_SPINE_LENGTH,
  },
  railSpineLabel: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.4,
    lineHeight: RAIL_SPINE_LINE,
  },
  railLabel: {
    fontSize: 11,
    lineHeight: 14,
    textAlign: 'center',
  },
  footerColumn: {
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    width: '100%',
  },
  content: {
    alignSelf: 'center',
    // Spacing.five was calibrated when the title and every menu row carried a
    // subtitle under it. With those gone the page was mostly air between four
    // short lines, so the section rhythm comes in one step to match.
    gap: Spacing.four,
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    width: '100%',
  },
  back: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.one,
    // Pulls the back link up against the title rather than a full section step
    // away from it; the negative tracks `content.gap` and must move with it.
    marginBottom: -Spacing.three,
    minHeight: 32,
  },
  backLabel: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 1.6,
    lineHeight: 14,
  },
  title: {
    fontFamily: BrandFonts.display,
    fontSize: 34,
    // Stated as well as named — see the note in `settings-menu-row.tsx`.
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: 38,
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
  sectionRule: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: Spacing.one,
  },
  sectionLabel: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 1.6,
    lineHeight: 14,
  },
});
