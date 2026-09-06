import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

interface SettingsPageProps {
  readonly title: string;
  readonly subtitle: string;
  /**
   * `root` is the menu itself: it owns the sheet, so it closes it. `sub` is one
   * menu deep and pops back to the menu instead.
   */
  readonly kind?: 'root' | 'sub';
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
export function SettingsPage({ title, subtitle, kind = 'sub', children }: SettingsPageProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={[
        styles.content,
        {
          paddingTop: insets.top + Spacing.four,
          paddingBottom: insets.bottom + Spacing.six,
        },
      ]}
    >
      {kind === 'sub' ? (
        <Pressable
          accessibilityLabel="Back to settings"
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
          <ThemedText type="smallBold" themeColor="textSecondary" style={styles.backLabel}>
            SETTINGS
          </ThemedText>
        </Pressable>
      ) : null}

      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <ThemedText type="subtitle">{title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {subtitle}
          </ThemedText>
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
}

/** A labelled group of rows inside a {@link SettingsPage}. */
export function SettingsSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="smallBold" themeColor="textSecondary" style={styles.sectionLabel}>
        {label}
      </ThemedText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    alignSelf: 'center',
    gap: Spacing.five,
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    width: '100%',
  },
  back: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.one,
    marginBottom: -Spacing.four,
    minHeight: 32,
  },
  backLabel: {
    letterSpacing: 1,
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
  sectionLabel: {
    letterSpacing: 1,
  },
});
