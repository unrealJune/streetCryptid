import { WithSkiaWeb } from '@shopify/react-native-skia/lib/module/web';
import { StyleSheet, View } from 'react-native';

import { useMapTheme } from '../hooks/use-map-theme';

/**
 * Web resolution of the map screen. CanvasKit (Skia's wasm build, served from
 * /public) must finish loading before anything imports the Skia runtime, so the
 * screen body is imported lazily behind `WithSkiaWeb`.
 *
 * This file lives under `src/features/` — NOT `src/app/` — on purpose: it
 * statically imports the Skia web entry, which pulls in `canvaskit-wasm`
 * (a Node-`fs` module). Anything under `src/app/` is swept into every platform
 * bundle by expo-router's require.context, so a `.web.tsx` there would still
 * break the Android build. Reached only via the bare `./map-screen` import,
 * which Metro resolves to `map-screen.tsx` on native and this file on web.
 */
export default function MapScreenWeb() {
  const theme = useMapTheme();
  return (
    <WithSkiaWeb
      getComponent={() => import('./map-screen-body')}
      opts={{ locateFile: (file: string) => `/${file}` }}
      fallback={<View style={[styles.fill, { backgroundColor: theme.chrome.bg }]} />}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
