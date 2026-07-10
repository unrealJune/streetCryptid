import { CryptidProfileEditor } from '../components/cryptid-profile-editor';
import { useCryptidProfile } from '../hooks/use-cryptid-profile';

export function AccountOnboardingScreen() {
  const { error, saveProfile } = useCryptidProfile();

  return (
    <CryptidProfileEditor
      mode="onboarding"
      notice={error}
      onSave={async (profile) => {
        await saveProfile(profile);
      }}
    />
  );
}
