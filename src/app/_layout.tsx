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
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StyleSheet, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { CryptidAccountGate } from '@/features/account/components/cryptid-account-gate';
import { CryptidProfileProvider } from '@/features/account/hooks/use-cryptid-profile';
import { LocationSharingProvider } from '@/features/social/hooks/use-location-sharing';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
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
              <AppTabs />
            </LocationSharingProvider>
          </CryptidAccountGate>
        </CryptidProfileProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
