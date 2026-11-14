import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface RepeaterCardCarry {
  /** Carries my location now. */
  readonly value: boolean;
  /** Under the switch: what on means, or why there is no switch. */
  readonly text: string;
  /** No switch at all: an invite-only roster nobody invited me to. */
  readonly locked?: boolean;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
  readonly onChange: (next: boolean) => void;
}

interface RepeaterCardProps {
  readonly title: string;
  /** Mono lines under the title: the roster in a line, who vouched, its machines. */
  readonly lines: readonly string[];
  readonly accent: string;
  /** Outlined in the accent: the card the person just acted on. */
  readonly highlighted?: boolean;
  /** The whole header opens something: a chevron, and the press. */
  readonly onOpen?: () => void;
  readonly openLabel?: string;
  /** A link under the header ("People", "Invite friends"). */
  readonly link?: { readonly label: string; readonly onPress: () => void };
  readonly carry?: RepeaterCardCarry;
}

/**
 * One thing that may carry your location, as Settings → Repeaters lists them: the stash, your own
 * roster, someone else's. The header says what it is; the one switch under a hairline is the only
 * choice there is about it for everyone (REPEATERS.md §2.1: carrying is the only opt-in).
 */
export function RepeaterCard({
  title,
  lines,
  accent,
  highlighted = false,
  onOpen,
  openLabel,
  link,
  carry,
}: RepeaterCardProps) {
  const theme = useTheme();
  const header = (
    <View style={styles.header}>
      <View style={styles.copy}>
        <ThemedText style={styles.title}>{title}</ThemedText>
        {lines.map((line) => (
          <ThemedText key={line} themeColor="textSecondary" style={styles.line}>
            {line}
          </ThemedText>
        ))}
      </View>
      {onOpen ? (
        <SymbolView
          name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
          size={13}
          tintColor={theme.textSecondary}
        />
      ) : null}
    </View>
  );

  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: highlighted ? accent : theme.backgroundSelected,
        },
      ]}
    >
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={openLabel ?? `Open ${title}`}
          onPress={onOpen}
          style={({ pressed }) => ({ opacity: pressed ? 0.58 : 1 })}
        >
          {header}
        </Pressable>
      ) : (
        header
      )}

      {link ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={link.label}
          onPress={link.onPress}
          style={({ pressed }) => [styles.link, { opacity: pressed ? 0.58 : 1 }]}
        >
          <ThemedText style={[styles.linkLabel, { color: accent }]}>
            {`${link.label.toUpperCase()} ›`}
          </ThemedText>
        </Pressable>
      ) : null}

      {carry ? (
        <View style={[styles.carry, { borderTopColor: theme.backgroundSelected }]}>
          <View style={styles.copy}>
            {carry.locked ? null : <ThemedText type="small">Carry my location</ThemedText>}
            <ThemedText type="small" themeColor="textSecondary">
              {carry.text}
            </ThemedText>
          </View>
          {carry.locked ? null : (
            <Switch
              accessibilityRole="switch"
              accessibilityLabel={carry.accessibilityLabel}
              disabled={carry.disabled}
              value={carry.value}
              onValueChange={carry.onChange}
              trackColor={{ true: accent, false: theme.backgroundSelected }}
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: 10 },
  copy: { flex: 1, gap: 2, minWidth: 0 },
  title: { fontFamily: BrandFonts.data, fontSize: 12.5, fontWeight: '600', lineHeight: 17 },
  line: { fontFamily: BrandFonts.data, fontSize: 10.5, lineHeight: 14 },
  link: { alignSelf: 'flex-start', minHeight: 28, justifyContent: 'center' },
  linkLabel: { fontFamily: BrandFonts.data, fontSize: 10.5, letterSpacing: 1.2 },
  carry: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    paddingTop: Spacing.two,
  },
});
