import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { CryptidProfileEditor } from './cryptid-profile-editor';

/**
 * DEBUG-only: render the real first-run profile editor over the app, with a save
 * that goes nowhere.
 *
 * `CryptidProfileEditor` autosaves through the `onSave` prop, so passing a no-op
 * (and a null `initialProfile`, the true first-run state) exercises the actual
 * onboarding layout and interactions without touching the stored profile. It is
 * the same component `AccountOnboardingScreen` mounts — not a copy — so what you
 * see here is what a new user sees.
 *
 * Works on web (`just web`) as well as on device: nothing in this path touches
 * Skia, so no CanvasKit gate is needed.
 */
export function ProfileOnboardingPreview({ accent }: { accent: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityHint="Renders first-run profile setup without saving anything"
        accessibilityLabel="Preview profile onboarding"
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.button,
          { borderColor: accent, opacity: pressed ? 0.62 : 1 },
        ]}
      >
        <ThemedText type="smallBold" style={{ color: accent }}>
          PREVIEW ONBOARDING
        </ThemedText>
      </Pressable>
      <ThemedText type="small" themeColor="textSecondary">
        Opens first-run profile setup. Nothing is saved.
      </ThemedText>

      <Modal animationType="slide" onRequestClose={() => setOpen(false)} visible={open}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <CryptidProfileEditor
            initialProfile={null}
            mode="onboarding"
            onDone={() => setOpen(false)}
            onSave={async () => {
              // Intentionally does nothing: the whole point is to leave the real
              // profile untouched. The editor still runs its full save lifecycle.
            }}
          />
          <Pressable
            accessibilityLabel="Close onboarding preview"
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={({ pressed }) => [
              styles.close,
              { backgroundColor: theme.backgroundElement, opacity: pressed ? 0.62 : 1 },
            ]}
          >
            <ThemedText type="smallBold">CLOSE PREVIEW</ThemedText>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  button: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  sheet: {
    flex: 1,
  },
  close: {
    alignItems: 'center',
    borderRadius: 8,
    margin: Spacing.three,
    paddingVertical: Spacing.two,
  },
});
