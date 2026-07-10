import { CryptidProfileEditor } from '../components/cryptid-profile-editor';
import { useCryptidProfile } from '../hooks/use-cryptid-profile';

export function AccountOnboardingScreen({
  onAutosaveStart,
  onComplete,
}: {
  onAutosaveStart: () => void;
  onComplete: () => void;
}) {
  const { error, profile, saveProfile } = useCryptidProfile();

  return (
    <CryptidProfileEditor
      initialProfile={profile}
      mode="onboarding"
      notice={error}
      onDone={onComplete}
      onSave={async (profile) => {
        onAutosaveStart();
        await saveProfile(profile);
      }}
    />
  );
}
