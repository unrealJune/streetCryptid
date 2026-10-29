import { type ReactNode, useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, MaxContentWidth, Spacing } from '@/constants/theme';
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
  children,
}: SettingsPageProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scroll = useRef<ScrollView>(null);

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
          paddingBottom: footer ? Spacing.four : insets.bottom + Spacing.six,
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
      <PageFooter>{footer}</PageFooter>
    </View>
  );
}

/**
 * A full-screen page's actions, pinned under its scroll in the same centred column, above the
 * bottom inset. The hairline is what says the text above continues behind it.
 */
export function PageFooter({
  maxWidth = MaxContentWidth,
  children,
}: {
  /** Match the column above when it is narrower than a settings page's. */
  readonly maxWidth?: number;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

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
