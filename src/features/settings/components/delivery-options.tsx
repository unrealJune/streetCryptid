import { useMemo, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

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
  const previewWidth = Math.round((width - Spacing.four) * 0.52);
  const controlsWidth = width - Spacing.four - previewWidth;
  const options = useMemo(() => deliveryModeOptions(availability), [availability]);
  // Tallest explanation of any option, measured off screen and reserved, so choosing an option
  // with a longer explanation never moves the picker out from under the finger that chose it.
  const [copyHeights, setCopyHeights] = useState<Partial<Record<DeliveryMode, number>>>({});
  const copyMinHeight = Math.max(0, ...Object.values(copyHeights));
  // Stacked, the preview takes what the window has left once the explanation, the picker and the
  // page's own chrome are placed: a fixed 340 pt filled a folded foldable's cover screen and put
  // the choice below the fold.
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const stackedPreviewHeight = Math.round(
    Math.min(
      STACKED_PREVIEW_MAX,
      Math.max(
        STACKED_PREVIEW_MIN,
        window.height - insets.top - insets.bottom - STACKED_PAGE_CHROME - copyMinHeight
      )
    )
  );
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
      <DeliveryPreview
        height={twoColumn ? 300 : stackedPreviewHeight}
        mode={selected}
        palette={stagePalette}
      />
    </View>
  );
  const controls = (
    <>
      <View style={[styles.copy, { minHeight: copyMinHeight }]}>
        <DeliveryCopy mode={selected} />
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
      <View
        pointerEvents="none"
        style={[styles.measure, { width: twoColumn ? controlsWidth : width }]}
      >
        {options.map((option) => (
          <View
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            key={option.id}
            onLayout={({ nativeEvent }) => {
              const height = Math.ceil(nativeEvent.layout.height);
              setCopyHeights((current) =>
                current[option.id] === height ? current : { ...current, [option.id]: height }
              );
            }}
            style={styles.copy}
          >
            <DeliveryCopy mode={option.id} />
          </View>
        ))}
      </View>
    </View>
  );
}

function DeliveryCopy({ mode }: { mode: DeliveryMode }) {
  const copy = DELIVERY_MODE_COPY[mode];
  return (
    <>
      <ThemedText type="smallBold">
        {mode === 'mutual' ? 'Mutual friend relay' : copy.title}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {mode === 'mutual' ? mutualFriendRelayExplanation(Platform.OS) : copy.body}
      </ThemedText>
    </>
  );
}

/** Content width at which the preview and the choice sit side by side. */
const TWO_COLUMN_MIN_WIDTH = 600;
const STACKED_PREVIEW_MAX = 340;
const STACKED_PREVIEW_MIN = 150;
/**
 * Everything on a stacked page that is not the preview or the explanation: the page title, the
 * island's padding, the picker, the gaps between them and a pinned Back/Continue footer. Measured
 * on the iPhone Duo's cover screen (678 pt), where it has to fit with no scroll.
 */
const STACKED_PAGE_CHROME = 300;

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
  measure: { left: 0, opacity: 0, position: 'absolute', top: 0 },
});
