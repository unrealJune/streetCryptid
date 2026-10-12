import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { DEFAULT_PEAK_LABEL_OPTIONS, type PeakLabelOptions } from '../core/map-labels';
import { IslandPressable } from './glass-surface';

export function PeakLabelSettings({
  visible,
  options,
  peaksEnabled,
  theme,
  onChange,
  onClose,
}: {
  visible: boolean;
  options: PeakLabelOptions;
  peaksEnabled: boolean;
  theme: CryptidTheme;
  onChange(options: PeakLabelOptions): void;
  onClose(): void;
}) {
  const insets = useSafeAreaInsets();
  const textStyle = [styles.text, { color: theme.chrome.ink }];
  return (
    <Modal transparent visible={visible} onRequestClose={onClose} animationType="none">
      <View
        style={[
          styles.backdrop,
          { paddingTop: insets.top + Spacing.three, paddingBottom: insets.bottom + Spacing.three },
        ]}
      >
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { backgroundColor: theme.chrome.bg }]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={[textStyle, styles.heading]}>
              Peak cutoffs
            </Text>
            <IslandPressable
              accessibilityLabel="Close peak cutoffs"
              accessibilityRole="button"
              onPress={onClose}
              radius={12}
              style={styles.button}
              theme={theme}
            >
              <Text style={textStyle}>Done</Text>
            </IslandPressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={textStyle}>
              Applies immediately for this map screen session. Camera and downloaded tiles stay
              unchanged. Only named peaks and volcanoes already in the tiles can appear.
            </Text>
            {!peaksEnabled ? (
              <Text style={textStyle}>
                Peaks are hidden. Turn on Peaks in Map layers to see changes.
              </Text>
            ) : null}
            <NumberSetting
              label="Minimum zoom"
              value={options.minZoom}
              min={0}
              max={20}
              step={0.5}
              onChange={(minZoom) => onChange({ ...options, minZoom })}
              theme={theme}
            />
            <Text style={textStyle}>
              Lower zoom shows peaks farther out, if the tiles contain them. Uses the loaded
              region&apos;s zoom.
            </Text>
            <IslandPressable
              accessibilityLabel="Automatic peak rank cutoff"
              accessibilityRole="switch"
              accessibilityState={{ checked: options.maxRank === null }}
              onPress={() => onChange({ ...options, maxRank: options.maxRank === null ? 8 : null })}
              radius={12}
              style={styles.button}
              theme={theme}
            >
              <Text style={textStyle}>
                Rank: {options.maxRank === null ? 'Auto (zoom-dependent)' : 'Manual'}
              </Text>
            </IslandPressable>
            <Text style={textStyle}>
              Auto allows rank 2 at zoom 9, 4 at 11, 8 at 13, doubling every two zoom levels. Lower
              ranks are more prominent. Manual includes ranks up to the maximum at every zoom.
            </Text>
            {options.maxRank !== null ? (
              <NumberSetting
                label="Maximum rank"
                value={options.maxRank}
                min={1}
                max={128}
                step={1}
                onChange={(maxRank) => onChange({ ...options, maxRank })}
                theme={theme}
              />
            ) : null}
            <NumberSetting
              label="Maximum peak labels"
              value={options.maxLabels}
              min={0}
              max={64}
              step={1}
              onChange={(maxLabels) => onChange({ ...options, maxLabels })}
              theme={theme}
            />
            <Text style={textStyle}>
              Cap per loaded region, including off-screen padding. Nearest first; collisions may
              show fewer. Zero hides peak labels.
            </Text>
            <IslandPressable
              accessibilityLabel="Include unranked peaks"
              accessibilityRole="switch"
              accessibilityState={{ checked: options.includeUnranked }}
              onPress={() => onChange({ ...options, includeUnranked: !options.includeUnranked })}
              radius={12}
              style={styles.button}
              theme={theme}
            >
              <Text style={textStyle}>
                Unranked peaks: {options.includeUnranked ? 'Included' : 'Excluded'}
              </Text>
            </IslandPressable>
            <IslandPressable
              accessibilityLabel="Reset peak cutoffs"
              accessibilityRole="button"
              onPress={() => onChange(DEFAULT_PEAK_LABEL_OPTIONS)}
              radius={12}
              style={styles.button}
              theme={theme}
            >
              <Text style={textStyle}>Reset defaults</Text>
            </IslandPressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  onChange,
  theme,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  theme: CryptidTheme;
}) {
  const textStyle = [styles.text, { color: theme.chrome.ink }];
  return (
    <View style={styles.field}>
      <Text accessibilityLiveRegion="polite" style={textStyle}>
        {label}: {value}
      </Text>
      <View style={styles.stepper}>
        {([-1, 1] as const).map((direction) => {
          const disabled = direction < 0 ? value <= min : value >= max;
          return (
            <IslandPressable
              key={direction}
              accessibilityLabel={`${direction < 0 ? 'Decrease' : 'Increase'} ${label.toLowerCase()}`}
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              onPress={() => onChange(Math.max(min, Math.min(max, value + step * direction)))}
              radius={12}
              style={[styles.button, { opacity: disabled ? 0.4 : 1 }]}
              theme={theme}
            >
              <Text style={textStyle}>{direction < 0 ? '−' : '+'}</Text>
            </IslandPressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  dialog: { width: '100%', maxWidth: 480, maxHeight: '100%', borderRadius: 20, flexShrink: 1 },
  header: { padding: Spacing.three, gap: Spacing.two },
  content: { padding: Spacing.three, gap: Spacing.three },
  heading: { fontSize: 24 },
  text: { fontFamily: 'Rajdhani_600SemiBold', fontSize: 17 },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: Spacing.three },
  field: { gap: Spacing.two },
  stepper: { flexDirection: 'row', gap: Spacing.three },
});
