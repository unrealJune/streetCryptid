import '@/features/social/net/background/register-task';

import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_600SemiBold,
} from '@expo-google-fonts/ibm-plex-mono';
import {
  Rajdhani_500Medium,
  Rajdhani_600SemiBold,
  Rajdhani_700Bold,
} from '@expo-google-fonts/rajdhani';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StyleSheet, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { CryptidAccountGate } from '@/features/account/components/cryptid-account-gate';
import { CryptidProfileProvider } from '@/features/account/hooks/use-cryptid-profile';
import { installConsoleTelemetryBridge } from '@/features/dev/telemetry';
import { LocationDisclosureGate } from '@/features/social/components/location-disclosure-gate';
import { PairingOverlays } from '@/features/social/components/pairing-overlays';
import { LocationSharingProvider } from '@/features/social/hooks/use-location-sharing';

// Keep warnings/errors in the local event journal and optionally ship them to the OTLP collector.
installConsoleTelemetryBridge();

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [fontsLoaded] = useFonts({
    Rajdhani_500Medium,
    Rajdhani_600SemiBold,
    Rajdhani_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  // The native splash stays up (preventAutoHideAsync) until the overlay below
  // mounts and hides it, so returning null here just extends the splash.
  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <CryptidProfileProvider>
          <AnimatedSplashOverlay />
          <CryptidAccountGate>
            <LocationSharingProvider>
              <LocationDisclosureGate>
                {/* No tab bar, no header: the map is the app, and everything else
                    is a floating island or a sheet pushed over it. */}
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="index" />
                  <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
                </Stack>
                {/* Pairing interrupts are global: a verification challenge or a
                    discovery can land while you are anywhere in the app. */}
                <PairingOverlays />
              </LocationDisclosureGate>
            </LocationSharingProvider>
          </CryptidAccountGate>
        </CryptidProfileProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
