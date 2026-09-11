import { useRouter } from 'expo-router';

import { CryptidProfileEditor } from '../components/cryptid-profile-editor';
import { useCryptidProfile } from '../hooks/use-cryptid-profile';

/**
 * Your own cryptid, as a Settings page.
 *
 * It used to be an `<Modal presentationStyle="pageSheet">` opened from the identity row, which
 * made it the one thing in Settings that arrived by sliding UP — a second sheet stacked on the
 * sheet you were already in, with its own dismissal rules. Every other entry in the menu pushes.
 * Editing your profile is not a different kind of act from choosing a color scheme, so it no
 * longer looks like one: this is a route under `settings/`, and it pushes and pops like the rest.
 *
 * The editor autosaves, so leaving by the back swipe is as safe as leaving by Done — which is why
 * it can keep its own Done button as the page's commit action rather than borrowing
 * `SettingsPage`'s ‹ SETTINGS chrome, whose ScrollView it would have had to nest inside.
 */
export default function ProfileScreen() {
  const router = useRouter();
  const { error, profile, saveProfile } = useCryptidProfile();

  // The gate above this route guarantees a profile before the map mounts; render nothing rather
  // than an empty form in the window where one is still loading.
  if (!profile) return null;

  return (
    <CryptidProfileEditor
      initialProfile={profile}
      mode="edit"
      notice={error}
      onDone={() => router.back()}
      onSave={async (next) => {
        await saveProfile(next);
      }}
    />
  );
}
