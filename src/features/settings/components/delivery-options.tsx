import { useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import {
  DELIVERY_MODE_COPY,
  deliveryModeOptions,
  isDeliveryModeDowngraded,
  mutualFriendRelayExplanation,
  type DeliveryAvailability,
  type DeliveryMode,
} from '@/features/social/core/delivery-mode';

import { DeliveryModePicker } from './delivery-mode-picker';
import { DeliveryPreview } from './delivery-preview';
import type { DeliveryStagePalette } from './delivery-stage';

interface DeliveryOptionsProps {
  readonly selected: DeliveryMode;
  readonly availability: DeliveryAvailability;
  readonly disabled?: boolean;
  onSelect(mode: DeliveryMode): void;
}

export function DeliveryOptions({
  selected,
  availability,
  disabled,
  onSelect,
}: DeliveryOptionsProps) {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const [width, setWidth] = useState(0);
  const twoColumn = width >= TWO_COLUMN_MIN_WIDTH;
  // Explicit widths, not flex shares: the stage is `width: '100%'`, and Yoga resolved that against
  // the whole row and gave the preview most of it.
  const previewWidth = Math.round((width - Spacing.four) * 0.58);
  const controlsWidth = width - Spacing.four - previewWidth;
  const options = useMemo(() => deliveryModeOptions(availability), [availability]);
  const copy = DELIVERY_MODE_COPY[selected];
  const stagePalette: DeliveryStagePalette = useMemo(
    () => ({
      accent: chrome.green,
      ramp: [chrome.steelDark, chrome.steel, chrome.green, chrome.green],
      surface: chrome.panel,
      surfaceOff: chrome.void,
      label: chrome.ink,
      hairline: chrome.hairline,
      warning: chrome.amber,
      ground: chrome.bg,
    }),
    [chrome]
  );

  const preview = (
    <View
      style={[
        styles.island,
        twoColumn ? { width: previewWidth } : null,
        { backgroundColor: chrome.island, borderColor: chrome.islandBorder },
      ]}
    >
      <DeliveryPreview height={twoColumn ? 300 : 340} mode={selected} palette={stagePalette} />
    </View>
  );
  const controls = (
    <>
      <View style={styles.copy}>
        <ThemedText type="smallBold">
          {selected === 'mutual' ? 'Mutual friend relay' : copy.title}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {selected === 'mutual' ? mutualFriendRelayExplanation(Platform.OS) : copy.body}
        </ThemedText>
      </View>
      <DeliveryModePicker
        accent={chrome.green}
        options={options}
        selected={selected}
        disabled={disabled}
        onSelect={onSelect}
      />
      {isDeliveryModeDowngraded(selected, availability) ? (
        <ThemedText type="small" style={{ color: chrome.amber }}>
          No stash server is configured for this build, so delivery uses mutual friends. Your choice
          is remembered.
        </ThemedText>
      ) : null}
    </>
  );

  // Side by side once there is room for both: stacked, the 340 pt preview filled a landscape
  // foldable's whole first screen, and nothing said the choice itself was below it.
  return (
    <View
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      style={twoColumn ? styles.heroRow : styles.hero}
    >
      {preview}
      {twoColumn ? (
        <View style={[styles.controlsColumn, { width: controlsWidth }]}>{controls}</View>
      ) : (
        controls
      )}
    </View>
  );
}

/** Content width at which the preview and the choice sit side by side. */
const TWO_COLUMN_MIN_WIDTH = 600;

const styles = StyleSheet.create({
  hero: { gap: Spacing.three },
  heroRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.four },
  controlsColumn: { gap: Spacing.three },
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: Spacing.two,
  },
  copy: { gap: Spacing.two },
});
