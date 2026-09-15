import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { BrandFonts, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { useTheme } from '@/hooks/use-theme';

/**
 * Your own cryptid: sigil, handle, and signal color, with the editor behind it.
 *
 * This used to sit in the Friends screen header. The roster is now an island over the map
 * and only answers "who is out there", so the one row that is about *you* belongs here
 * instead.
 *
 * It is a PLATE rather than a menu row — the sigil at a size you can actually read it at,
 * the handle in your own signal color — because it is the only thing on this screen that
 * is yours, and a settings menu whose first entry says "Profile ›" in the same weight as
 * "App & Data ›" has no focal point at all. It is also the one place in Settings where a
 * 44pt sigil squeezed into a row's right-hand value column looked like a rendering fault.
 *
 * It pushes `settings/profile` rather than presenting the editor in its own `<Modal>`. The
 * modal was the only thing in Settings that arrived by sliding up over the sheet it was
 * opened from, which made the profile read as a different class of thing from every other
 * entry in the menu — see {@link ProfileScreen}.
 */
export function IdentityRow({ accent }: { readonly accent: string }) {
  const theme = useTheme();
  const router = useRouter();
  const { profile } = useCryptidProfile();
  const signalColor = resolveSignalColor(profile?.color, accent);
  const handle = profile?.handle ?? '@you';
  // The cryptid's name, or the invitation to pick one. Never an empty second line: the
  // plate's proportions are built on two, and a profile with no name yet is exactly the
  // state that most needs a tap target explaining itself.
  const caption = profile?.cryptidName ?? 'Tap to choose your cryptid';

  return (
    <Pressable
      accessibilityHint="Change your sigil, handle, or signal color"
      accessibilityLabel="Profile"
      accessibilityValue={{ text: handle }}
      accessibilityRole="button"
      onPress={() => router.push('/settings/profile')}
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
        showLabel={false}
        style={styles.avatar}
      />
      <View style={styles.copy}>
        <ThemedText numberOfLines={1} style={[styles.handle, { color: signalColor }]}>
          {handle}
        </ThemedText>
        <ThemedText numberOfLines={1} style={[styles.caption, { color: theme.textSecondary }]}>
          {caption.toUpperCase()}
        </ThemedText>
      </View>
      <SymbolView
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        size={13}
        tintColor={theme.textSecondary}
      />
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
    minHeight: 96,
    paddingVertical: Spacing.three,
  },
  avatar: {
    // Fixed, not flexible: `CryptidAvatar` scales its art down to the width it is given,
    // so this number IS the sigil's size. Left to flex it redrew at a different scale for
    // every cryptid, and the plate's left edge moved with it.
    width: 88,
    flexShrink: 0,
  },
  copy: {
    flex: 1,
    gap: 2,
    minWidth: 0,
  },
  handle: {
    fontFamily: BrandFonts.display,
    fontSize: 27,
    fontWeight: '700',
    lineHeight: 30,
  },
  caption: {
    fontFamily: BrandFonts.data,
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 1.3,
    lineHeight: 14,
  },
});
