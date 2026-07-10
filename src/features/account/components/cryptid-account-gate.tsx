import { useState, type PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { useCryptidProfile } from '../hooks/use-cryptid-profile';
import { AccountOnboardingScreen } from '../screens/account-onboarding-screen';

export function CryptidAccountGate({ children }: PropsWithChildren) {
  const theme = useTheme();
  const { status, profile } = useCryptidProfile();
  const [onboardingActive, setOnboardingActive] = useState(false);

  if (status === 'loading') {
    return <View style={[styles.loading, { backgroundColor: theme.background }]} />;
  }
  if (onboardingActive || !profile) {
    return (
      <AccountOnboardingScreen
        onAutosaveStart={() => setOnboardingActive(true)}
        onComplete={() => setOnboardingActive(false)}
      />
    );
  }
  return children;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
  },
});
