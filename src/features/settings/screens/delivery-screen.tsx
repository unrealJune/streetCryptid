import { Suspense, lazy, useMemo, useState } from 'react';
import { StyleSheet, View, useColorScheme } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import {
  DELIVERY_MODE_COPY,
  deliveryModeOptions,
  isDeliveryModeDowngraded,
  type DeliveryAvailability,
  type DeliveryMode,
} from '@/features/social/core/delivery-mode';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { DEFAULT_SHARE_INTERVAL_MS } from '@/features/social/net/background/sampling-policy';
import { useTheme } from '@/hooks/use-theme';

import type { DeliveryStagePalette } from '../components/delivery-stage';
import { DeliveryModePicker } from '../components/delivery-mode-picker';
import { LocationAccessRow } from '../components/location-access-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';
import { ShareIntervalRow } from '../components/share-interval-row';

// Lazy so `@shopify/react-native-skia` never evaluates in the settings graph — on web that
// import snapshots `global.CanvasKit` at module-eval time, and doing it before the map's
// `WithSkiaWeb` has loaded CanvasKit freezes the Skia singleton for the whole session.
const DeliveryStage = lazy(() => import('../components/delivery-stage'));

const STAGE_HEIGHT = 340;

const NO_STASH_COPY =
  'No trail stash is deployed for this build, so this route is unavailable. Point EXPO_PUBLIC_TRAIL_STASH_URL/TICKET at a stash to enable it.';

/**
 * Delivery options — how your location travels.
 *
 * The two routes are genuine alternatives rather than a switch, so they are picked as one
 * exclusive choice and each is shown doing its own job: the diagram runs the mode you have
 * selected, failure included, because the failure is the part that distinguishes them. See
 * `delivery-timeline.ts` for what each loop is actually claiming, and `delivery-mode.ts` for
 * why there is no "direct only" route to offer.
 *
 * Below the picker sit the two settings that decide whether there is anything to deliver at
 * all — the OS permission, and how often a fix is published. They are not part of the route
 * choice, but they belong to the same question and have nowhere better to live.
 */
export default function DeliveryScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const theme = useTheme();

  const {
    snapshot,
    setDeliveryMode,
    setShareInterval,
    disclosureStatus,
    acknowledgeLocationDisclosure,
  } = useLocationSharing();

  // Memoised because it feeds `deliveryModeOptions`: a fresh object literal on every render
  // would rebuild the picker's options every frame the diagram advances.
  const availability = useMemo<DeliveryAvailability>(
    () => ({ stashConfigured: snapshot?.delivery.stashConfigured ?? false }),
    [snapshot?.delivery.stashConfigured]
  );
  const storedMode = snapshot?.delivery.mode ?? 'mutual';

  // Optimistic: `setDeliveryMode` persists and rebuilds native grants, which takes long enough
  // that a segmented control waiting on the snapshot reads as an unresponsive one. The pending
  // value is dropped as soon as the snapshot agrees.
  const [pending, setPending] = useState<DeliveryMode | null>(null);
  const selected = pending ?? storedMode;
  if (pending !== null && pending === storedMode) setPending(null);

  const options = useMemo(() => deliveryModeOptions(availability), [availability]);
  const copy = DELIVERY_MODE_COPY[selected];
  const selectedOption = options.find((option) => option.id === selected);
  const downgraded = isDeliveryModeDowngraded(storedMode, availability);

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

  const shareIntervalMs = snapshot?.shareIntervalMs ?? DEFAULT_SHARE_INTERVAL_MS;

  return (
    <SettingsPage title="Delivery system" subtitle="How your location travels">
      <View style={styles.hero}>
        <View
          style={[
            styles.island,
            { backgroundColor: chrome.island, borderColor: chrome.islandBorder },
          ]}
        >
          <Suspense fallback={<View style={{ height: STAGE_HEIGHT }} />}>
            <DeliveryStage height={STAGE_HEIGHT} mode={selected} palette={stagePalette} />
          </Suspense>
        </View>

        <View style={styles.copy}>
          <ThemedText type="smallBold">{copy.title}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {copy.body}
          </ThemedText>
          {copy.note ? (
            <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
              {copy.note}
            </ThemedText>
          ) : null}
          {selectedOption && !selectedOption.available ? (
            <ThemedText type="small" style={{ color: chrome.amber }}>
              {NO_STASH_COPY}
            </ThemedText>
          ) : null}
        </View>

        <DeliveryModePicker
          accent={chrome.green}
          options={options}
          selected={selected}
          onSelect={(mode) => {
            setPending(mode);
            void setDeliveryMode(mode);
          }}
        />

        {/* Said out loud rather than resolved silently: the stored choice is kept, so an install
            that later gains a stash comes back to what the person actually asked for. */}
        {downgraded ? (
          <ThemedText type="small" style={{ color: chrome.amber }}>
            {DELIVERY_MODE_COPY[storedMode].title} is not available on this build, so your trail is
            travelling by mutual relay. Your choice is remembered.
          </ThemedText>
        ) : null}
      </View>

      <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />

      <SettingsSection label="ACCESS">
        <LocationAccessRow
          accent={chrome.amber}
          status={disclosureStatus}
          onTurnOn={() => void acknowledgeLocationDisclosure(true)}
        />
      </SettingsSection>

      <SettingsSection label="CADENCE">
        <ShareIntervalRow
          accent={chrome.amber}
          intervalMs={shareIntervalMs}
          onSelect={(intervalMs) => void setShareInterval(intervalMs)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  hero: {
    gap: Spacing.three,
  },
  island: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: Spacing.two,
  },
  copy: {
    gap: Spacing.two,
  },
  note: {
    opacity: 0.8,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
});
