import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { DeliveryMode, DeliveryModeOption } from '@/features/social/core/delivery-mode';
import { useTheme } from '@/hooks/use-theme';

interface DeliveryModePickerProps {
  readonly options: readonly DeliveryModeOption[];
  readonly selected: DeliveryMode;
  readonly accent: string;
  readonly disabled?: boolean;
  onSelect(mode: DeliveryMode): void;
}

/**
 * The three routes, as one segmented control.
 *
 * Selection is carried by contrast — a filled track and a brighter label — not by colour alone,
 * the same rule the map's island tabs follow. An unavailable route is still shown and still
 * readable: "this build has no stash" is information, and hiding the segment would leave the
 * screen quietly describing two options while the person was told there are three.
 */
export function DeliveryModePicker({
  options,
  selected,
  accent,
  disabled = false,
  onSelect,
}: DeliveryModePickerProps) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.track, { borderColor: theme.backgroundSelected }]}
    >
      {options.map((option) => {
        const active = option.id === selected;
        const inert = disabled || !option.available;
        return (
          <Pressable
            accessibilityHint={option.available ? undefined : 'Not available on this build'}
            accessibilityLabel={`${option.title} delivery`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active, disabled: inert }}
            disabled={inert}
            key={option.id}
            // Guarded here as well as by `disabled`. `disabled` is enforced by the touch
            // responder, so it stops a finger but not a programmatic press — and "you cannot
            // choose a route this build cannot take" is an invariant of the picker, not a
            // detail of how RN happens to dispatch touches.
            onPress={() => {
              if (inert) return;
              onSelect(option.id);
            }}
            style={({ pressed }) => [
              styles.segment,
              active && { backgroundColor: `${accent}29` },
              { opacity: inert ? 0.42 : pressed ? 0.62 : 1 },
            ]}
            testID={`delivery-mode-${option.id}`}
          >
            <ThemedText
              type="code"
              style={[styles.label, active ? { color: accent } : undefined]}
              themeColor={active ? 'text' : 'textSecondary'}
            >
              {option.segment}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    backgroundColor: 'transparent',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.half,
    padding: Spacing.half,
  },
  segment: {
    alignItems: 'center',
    borderRadius: 999,
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
  },
  label: {
    letterSpacing: 1.4,
  },
});
