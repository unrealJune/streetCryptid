/**
 * Isolated native MapView entry for before/after profiling in a simulator dev client.
 * Point an archived source copy's package.json `main` here; leave the production entry intact.
 * EXPO_PUBLIC_MAP_PERF_RUN enables measurement; EXPO_PUBLIC_MAP_PERF_DEEP_ZOOM=1 adds z16–18.
 * Uses public downtown Seattle, no account gate, location subscription, or friend identity.
 */
import { registerRootComponent } from 'expo';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { MapView } from '../src/features/map/render/map-view';

const CENTER = { lat: 47.6097, lon: -122.3331 };

function NativeMapPerf() {
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={StyleSheet.absoluteFill}>
      <MapView initialCenter={CENTER} />
    </GestureHandlerRootView>
  );
}

registerRootComponent(NativeMapPerf);
