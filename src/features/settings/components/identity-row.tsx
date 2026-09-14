import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { useTheme } from '@/hooks/use-theme';

/**
 * Your own cryptid: sigil, handle, and signal color, with the editor behind it.
 *
 * This used to sit in the Friends screen header. The roster is now an island over
 * the map and only answers "who is out there", so the one row that is about *you*
 * belongs here instead.
 *
 * It pushes `settings/profile` rather than presenting the editor in its own `<Modal>`. The modal
 * was the only thing in Settings that arrived by sliding up over the sheet it was opened from,
 * which made the profile read as a different class of thing from every other entry in the menu —
 * see {@link ProfileScreen}. Now it is a row that pushes a page, exactly like the rows under it.
 */
export function IdentityRow({ accent }: { readonly accent: string }) {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useCryptidProfile();
  const signalColor = resolveSignalColor(profile?.color, accent);

  return (
    <Pressable
      accessibilityHint="Change your sigil, handle, or signal color"
      accessibilityLabel="Profile"
      accessibilityValue={{ text: profile?.handle ?? '@you' }}
      accessibilityRole="button"
      onPress={() => router.push('/settings/profile')}
      style={({ pressed }) => [
        styles.row,
        { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
      ]}
    >
      <View style={styles.copy}>
        <ThemedText type="smallBold">Profile</ThemedText>
      </View>
      <View style={styles.value}>
        <CryptidAvatar
          art={profile?.sigil ?? 'unknown'}
          color={signalColor}
          muted={false}
          name={profile?.cryptidName ?? 'Your cryptid'}
          showLabel={false}
          style={styles.avatar}
        />
        <ThemedText type="code" numberOfLines={1} style={[styles.handle, { color: signalColor }]}>
          {profile?.handle ?? '@you'}
        </ThemedText>
      </View>
      <ThemedText type="code" themeColor="textSecondary">
        {'>'}
      </ThemedText>
    </Pressable>
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
    width: 44,
    flexShrink: 0,
  },
  value: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: Spacing.two,
    maxWidth: '65%',
  },
  handle: {
    flexShrink: 1,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
});
