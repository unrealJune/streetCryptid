import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';

import { enrollFacts, ownerName, rosterLine, vouchLine, type RosterView } from '../core/repeaters';

import {
  FactList,
  IslandPanel,
  PanelActions,
  PanelButton,
  PanelRow,
  useRepeaterChrome,
} from './repeater-chrome';

/**
 * The question before someone else's repeaters carry you (REPEATERS.md §4.4): what it gives, what
 * it can never do, and what it costs, then ENROLL or NOT NOW. Asked from Settings → Repeaters when
 * an offered roster's switch is turned on; the pairing screen asks the same thing in its own panel.
 */
export function EnrollSheet({
  roster,
  busy,
  error,
  onEnroll,
  onDismiss,
}: {
  /** The roster being asked about; `null` hides the sheet. */
  readonly roster: RosterView | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onEnroll: () => void;
  readonly onDismiss: () => void;
}) {
  const { chrome } = useRepeaterChrome();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
      transparent
      visible={roster !== null}
    >
      <View style={[styles.scrim, { backgroundColor: chrome.scrim }]}>
        <Pressable
          accessibilityLabel="Not now"
          accessibilityRole="button"
          onPress={onDismiss}
          style={StyleSheet.absoluteFill}
        />
        {roster ? (
          <IslandPanel
            chrome={chrome}
            status={`REPLICATE YOUR LOCATION ON ${ownerName(roster).toUpperCase()}’S REPEATERS?`}
            statusColor={chrome.ink}
            detail={error ?? [rosterLine(roster), vouchLine(roster)].filter(Boolean).join(' · ')}
            marginBottom={Math.max(insets.bottom, Spacing.two)}
          >
            <PanelRow>
              <FactList chrome={chrome} facts={enrollFacts(roster)} />
            </PanelRow>
            <PanelActions>
              <PanelButton chrome={chrome} kind="outline" label="NOT NOW" onPress={onDismiss} />
              <PanelButton
                chrome={chrome}
                label="ENROLL"
                accessibilityLabel={`Enroll: carry my location on ${roster.ownerLabel}`}
                disabled={busy}
                onPress={onEnroll}
              />
            </PanelActions>
          </IslandPanel>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
