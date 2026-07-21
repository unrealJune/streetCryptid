import type { PropsWithChildren } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { useLocationSharing } from '../hooks/use-location-sharing';
import { LocationDisclosureScreen } from '../screens/location-disclosure-screen';

/**
 * Gates the app behind the background-location disclosure screen until the person has made a
 * choice. Mirrors `CryptidAccountGate`'s loading/gate/children shape. Must render inside
 * `LocationSharingProvider` (it reads `disclosureStatus`/`acknowledgeLocationDisclosure` from it).
 */
export function LocationDisclosureGate({ children }: PropsWithChildren) {
  const theme = useTheme();
  const { disclosureStatus, acknowledgeLocationDisclosure } = useLocationSharing();

  if (disclosureStatus === 'loading') {
    return <View style={[styles.loading, { backgroundColor: theme.background }]} />;
  }
  if (disclosureStatus === 'pending') {
    return (
      <LocationDisclosureScreen
        onChoice={(accepted) => void acknowledgeLocationDisclosure(accepted)}
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
