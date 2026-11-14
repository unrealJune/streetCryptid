import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { BrandFonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * The repeater pages' list kit: a tracked mono label over a card whose rows are split by
 * hairlines, each row a title, an optional mono detail, and one thing on the right (a switch, a
 * chevron, an outlined action). One shape for every row, so the stash, your roster and a friend's
 * read as entries in the same list.
 */

/** Ink on the accent fill, as the pairing screen sets it. */
export const ON_ACCENT = '#07131f';

const ROW_PADDING_H = 14;

export function GroupLabel({
  label,
  badge,
  badgeColor,
}: {
  readonly label: string;
  /** A count waiting on the person ("1 NEW"), in the accent. */
  readonly badge?: string;
  readonly badgeColor?: string;
}) {
  return (
    <View style={styles.labelRow}>
      <ThemedText themeColor="textSecondary" style={styles.label}>
        {label.toUpperCase()}
      </ThemedText>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: badgeColor }]}>
          <ThemedText style={[styles.badgeText, { color: ON_ACCENT }]}>{badge}</ThemedText>
        </View>
      ) : null}
    </View>
  );
}

/** A labelled group: the label, then whatever follows it (usually one {@link GroupCard}). */
export function Group({
  label,
  badge,
  badgeColor,
  children,
}: {
  readonly label?: string;
  readonly badge?: string;
  readonly badgeColor?: string;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.group}>
      {label ? <GroupLabel label={label} badge={badge} badgeColor={badgeColor} /> : null}
      {children}
    </View>
  );
}

export function GroupCard({ children }: { readonly children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.backgroundSelected },
      ]}
    >
      {children}
    </View>
  );
}

interface GroupRowProps {
  readonly title: string;
  /** Mono, under the title: what it is right now ("2 machines · 4 people"). */
  readonly detail?: string | null;
  /** Prose under the title: what the right-hand control means. */
  readonly text?: string | null;
  readonly first?: boolean;
  readonly dimmed?: boolean;
  /** The whole row opens something, with a chevron. */
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly right?: ReactNode;
  /** Under the row's main line, full width (a confirmation, a row's actions). */
  readonly below?: ReactNode;
}

export function GroupRow({
  title,
  detail,
  text,
  first = false,
  dimmed = false,
  onPress,
  accessibilityLabel,
  right,
  below,
}: GroupRowProps) {
  const theme = useTheme();
  const body = (
    <>
      <View style={styles.rowMain}>
        <View style={styles.copy}>
          <ThemedText
            style={[styles.title, dimmed && { color: theme.textSecondary }]}
            numberOfLines={2}
          >
            {title}
          </ThemedText>
          {detail ? (
            <ThemedText themeColor="textSecondary" style={styles.detail} numberOfLines={2}>
              {detail}
            </ThemedText>
          ) : null}
          {text ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.text}>
              {text}
            </ThemedText>
          ) : null}
        </View>
        {right}
        {onPress ? (
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={13}
            tintColor={theme.textSecondary}
          />
        ) : null}
      </View>
      {below}
    </>
  );
  const rowStyle = [
    styles.row,
    !first && {
      borderTopColor: theme.backgroundSelected,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
  ];
  return onPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [...rowStyle, pressed && styles.pressed]}
    >
      {body}
    </Pressable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

export function RowSwitch({
  value,
  accent,
  disabled = false,
  accessibilityLabel,
  onChange,
}: {
  readonly value: boolean;
  readonly accent: string;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
  readonly onChange: (next: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <Switch
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      value={value}
      onValueChange={onChange}
      trackColor={{ true: accent, false: theme.backgroundSelected }}
    />
  );
}

/** A small outlined action at the end of a row: INVITE, REMOVE, ···. */
export function RowButton({
  label,
  color,
  borderColor,
  disabled = false,
  accessibilityLabel,
  onPress,
}: {
  readonly label: string;
  /** Text colour; the theme's text when omitted. */
  readonly color?: string;
  readonly borderColor?: string;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { borderColor: borderColor ?? theme.backgroundSelected },
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <ThemedText style={[styles.buttonLabel, { color: color ?? theme.text }]}>{label}</ThemedText>
    </Pressable>
  );
}

/** A row that adds something: a + and a label in the accent. */
export function AddRow({
  label,
  accent,
  first = false,
  onPress,
}: {
  readonly label: string;
  readonly accent: string;
  readonly first?: boolean;
  readonly onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        styles.addRow,
        !first && {
          borderTopColor: theme.backgroundSelected,
          borderTopWidth: StyleSheet.hairlineWidth,
        },
        pressed && styles.pressed,
      ]}
    >
      <ThemedText style={[styles.plus, { color: accent }]}>+</ThemedText>
      <ThemedText style={[styles.title, { color: accent }]}>{label}</ThemedText>
    </Pressable>
  );
}

/** Two or more exclusive choices, as one control: INVITE ONLY | ANYONE. */
export function Segmented<T extends string>({
  options,
  value,
  disabled = false,
  accessibilityLabel,
  onChange,
}: {
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly value: T;
  readonly disabled?: boolean;
  readonly accessibilityLabel: string;
  readonly onChange: (next: T) => void;
}) {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.segmented, { backgroundColor: theme.backgroundSelected }]}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: on, disabled }}
            disabled={disabled}
            onPress={() => {
              if (!on) onChange(option.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              on && { backgroundColor: theme.text },
              (pressed || disabled) && styles.pressed,
            ]}
          >
            <ThemedText
              style={[styles.segmentLabel, { color: on ? theme.background : theme.textSecondary }]}
            >
              {option.label.toUpperCase()}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: Spacing.two },
  labelRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  label: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 1.6,
    lineHeight: 14,
  },
  badge: { borderRadius: 9, paddingHorizontal: 7, paddingVertical: 1 },
  badgeText: { fontFamily: BrandFonts.data, fontSize: 10, fontWeight: '700', lineHeight: 14 },
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    gap: Spacing.two,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: ROW_PADDING_H,
    paddingVertical: 10,
  },
  rowMain: { alignItems: 'center', flexDirection: 'row', gap: 12 },
  copy: { flex: 1, gap: 2, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '500', lineHeight: 20 },
  detail: { fontFamily: BrandFonts.data, fontSize: 11, lineHeight: 15 },
  text: { fontSize: 13, lineHeight: 18 },
  pressed: { opacity: 0.58 },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1,
    height: 32,
    justifyContent: 'center',
    minWidth: 36,
    paddingHorizontal: 10,
  },
  buttonLabel: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 1.1,
    lineHeight: 14,
  },
  addRow: { alignItems: 'center', flexDirection: 'row', minHeight: 48 },
  plus: { fontSize: 20, lineHeight: 22 },
  segmented: { borderRadius: 9, flexDirection: 'row', padding: 3 },
  segment: {
    alignItems: 'center',
    borderRadius: 7,
    flex: 1,
    height: 32,
    justifyContent: 'center',
  },
  segmentLabel: { fontFamily: BrandFonts.data, fontSize: 11, letterSpacing: 1, lineHeight: 14 },
});
