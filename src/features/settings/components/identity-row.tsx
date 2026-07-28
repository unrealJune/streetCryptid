import { useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { CryptidProfileEditor } from '@/features/account/components/cryptid-profile-editor';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { useTheme } from '@/hooks/use-theme';

/**
 * Your own cryptid: sigil, handle, and signal color, with the editor behind it.
 *
 * This used to sit in the Friends screen header. The roster is now an island over
 * the map and only answers "who is out there", so the one row that is about *you*
 * belongs here instead.
 */
export function IdentityRow({ accent }: { readonly accent: string }) {
  const theme = useTheme();
  const account = useCryptidProfile();
  const { profile } = account;
  const [editing, setEditing] = useState(false);
  const signalColor = resolveSignalColor(profile?.color, accent);

  return (
    <>
      <Pressable
        accessibilityHint="Change your sigil, handle, or signal color"
        accessibilityLabel={`Edit ${profile?.handle ?? 'your'} cryptid profile`}
        accessibilityRole="button"
        onPress={() => setEditing(true)}
        style={({ pressed }) => [
          styles.row,
          { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
        ]}
      >
        <CryptidAvatar
          art={profile?.sigil ?? 'unknown'}
          color={signalColor}
          muted={false}
          name={profile?.cryptidName ?? 'Your cryptid'}
          style={styles.avatar}
        />
        <View style={styles.copy}>
          <ThemedText type="smallBold" style={{ color: signalColor }}>
            {profile?.handle ?? '@you'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            This is the sigil and signal color your friends see.
          </ThemedText>
        </View>
        <ThemedText type="code" themeColor="textSecondary">
          {'>'}
        </ThemedText>
      </Pressable>

      <Modal
        animationType="slide"
        onRequestClose={() => setEditing(false)}
        presentationStyle="pageSheet"
        visible={editing && profile !== null}
      >
        {profile ? (
          <CryptidProfileEditor
            initialProfile={profile}
            mode="edit"
            notice={account.error}
            onDone={() => setEditing(false)}
            onSave={async (nextProfile) => {
              await account.saveProfile(nextProfile);
            }}
          />
        ) : null}
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 92,
    paddingVertical: Spacing.two,
  },
  avatar: {
    width: 88,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
});
