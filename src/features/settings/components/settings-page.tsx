import { type ReactNode, useEffect, useRef } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, MaxContentWidth, Spacing } from '@/constants/theme';
import { LEADING_SCROLL_BAR, useSystemRail } from '@/hooks/use-system-rail';
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
  const railWidth = useSystemRail();
  const railed = railWidth > 0 && footerRail !== undefined;
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
      // Beside the rail's tabs the scroll bar moves to the leading edge, clear of them.
      style={[
        {
          backgroundColor: theme.background,
          paddingLeft: railed ? insets.right : insets.left,
          paddingRight: railed ? insets.left : insets.right,
        },
        railed && LEADING_SCROLL_BAR,
      ]}
      contentContainerStyle={[
        styles.content,
        railed && LEADING_SCROLL_BAR,
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
  /** A shorter label for the rail, where each letter takes a line. Eight letters fit. */
  readonly railLabel?: string;
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
 * The primary action as a tall tab against the screen's right edge, its label set as a column of
 * letters in the display face: the rail is too narrow to set "Continue" across, and a label turned
 * on its side made you tilt your head to read it.
 */
function RailPrimary({ action }: { action: RailAction }) {
  const theme = useTheme();
  const fill = action.color ?? theme.text;
  const ink = action.ink ?? theme.background;
  const letters = (action.railLabel ?? action.label).replace(/…|\.\.\./g, '').toUpperCase();
  return (
    <Pressable
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: action.disabled, busy: action.busy }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => ({ opacity: action.disabled ? 0.4 : pressed ? 0.65 : 1 })}
      testID={action.testID}
    >
      <HexTab fill={fill} height={RAIL_PRIMARY_HEIGHT} style={styles.railPrimary}>
        <View style={styles.railLetters}>
          {[...letters].map((letter, index) =>
            letter === ' ' ? (
              <View key={index} style={styles.railLetterGap} />
            ) : (
              <ThemedText key={index} style={[styles.railLetter, { color: ink }]}>
                {letter}
              </ThemedText>
            )
          )}
        </View>
        <SymbolView name={action.icon} size={28} tintColor={ink} weight="bold" />
      </HexTab>
    </Pressable>
  );
}

function RailButton({ action }: { action: RailAction }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={action.accessibilityLabel ?? action.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: action.disabled, busy: action.busy }}
      disabled={action.disabled}
      onPress={action.onPress}
      style={({ pressed }) => ({ opacity: action.disabled ? 0.4 : pressed ? 0.65 : 1 })}
      testID={action.testID}
    >
      <HexTab fill={theme.backgroundSelected} height={RAIL_BUTTON_HEIGHT} style={styles.railButton}>
        <SymbolView name={action.icon} size={20} tintColor={theme.text} weight="semibold" />
        <ThemedText numberOfLines={1} style={[styles.railButtonLabel, { color: theme.text }]}>
          {(action.railLabel ?? action.label).toUpperCase()}
        </ThemedText>
      </HexTab>
    </Pressable>
  );
}

/**
 * A tab with hex-cut corners on its leading side and a square trailing side, for sitting flush
 * against the screen edge. Drawn from plain views, so it needs no SVG or Skia: two border-trick
 * trapezoids for the cut ends and a rectangle between them.
 */
function HexTab({
  fill,
  height,
  style,
  children,
}: {
  fill: string;
  height: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={{ height, width: RAIL_TAB_WIDTH }}>
      <View
        style={[
          styles.hexCut,
          { borderBottomColor: fill, borderBottomWidth: RAIL_TAB_CUT, top: 0 },
        ]}
      />
      <View
        style={[styles.hexBody, { backgroundColor: fill, bottom: RAIL_TAB_CUT, top: RAIL_TAB_CUT }]}
      />
      <View
        style={[styles.hexCut, { borderTopColor: fill, borderTopWidth: RAIL_TAB_CUT, bottom: 0 }]}
      />
      <View style={[StyleSheet.absoluteFill, style]}>{children}</View>
    </View>
  );
}

/** The tabs' width: the rail less a gutter on the page side, since they sit flush on the other. */
const RAIL_TAB_WIDTH = 64;
/** How far each hex cut reaches in, both across and along the tab. */
const RAIL_TAB_CUT = 18;
const RAIL_PRIMARY_HEIGHT = 264;
const RAIL_BUTTON_HEIGHT = 92;

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
    alignItems: 'flex-end',
    gap: Spacing.three,
    position: 'absolute',
    right: 0,
  },
  railPrimary: {
    alignItems: 'center',
    gap: Spacing.three,
    justifyContent: 'space-between',
    // Optical centre: the cut takes the leading edge's corners, so the content leans trailing.
    paddingLeft: Spacing.one,
    paddingVertical: RAIL_TAB_CUT + Spacing.two,
  },
  railLetters: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  railLetter: {
    fontFamily: BrandFonts.display,
    fontSize: 19,
    fontWeight: '700',
    lineHeight: 20,
  },
  railLetterGap: {
    height: Spacing.two,
  },
  railButton: {
    alignItems: 'center',
    gap: Spacing.one,
    justifyContent: 'center',
    paddingLeft: Spacing.one,
  },
  railButtonLabel: {
    fontFamily: BrandFonts.display,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.6,
    lineHeight: 14,
  },
  hexCut: {
    borderLeftColor: 'transparent',
    borderLeftWidth: RAIL_TAB_CUT,
    height: 0,
    position: 'absolute',
    right: 0,
    width: RAIL_TAB_WIDTH,
  },
  hexBody: {
    left: 0,
    position: 'absolute',
    right: 0,
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
