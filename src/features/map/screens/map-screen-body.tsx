import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabInset, Spacing } from '@/constants/theme';
import { CoverageIsland, MapView, useMapTheme, type MapReadout } from '@/features/map';

/**
 * The map IS the product: full-bleed dot field with a single floating bottom
 * island. The island doubles as the accessible text model for the canvas.
 *
 * This is the shared screen body. It touches Skia (via `MapView`), so on web it
 * must only mount AFTER CanvasKit has loaded — `map-screen.web.tsx` gates it
 * behind `WithSkiaWeb`. Native renders it directly through `map-screen.tsx`.
 */
export default function MapScreenBody() {
  const theme = useMapTheme();
  const insets = useSafeAreaInsets();
  const [readout, setReadout] = useState<{ placeName: string | null; coverage: number }>({
    placeName: null,
    coverage: 0,
  });

  const onReadout = useCallback((next: MapReadout) => {
    setReadout((current) =>
      current.placeName === next.placeName && current.coverage === next.coverage
        ? current
        : { placeName: next.placeName, coverage: next.coverage }
    );
  }, []);

  const pct = Math.round(readout.coverage * 100);

  return (
    <View style={[styles.container, { backgroundColor: theme.chrome.bg }]}>
      <View
        style={styles.mapLayer}
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          readout.placeName
            ? `Map near ${readout.placeName}. ${pct} percent of visible sectors explored.`
            : 'Map loading.'
        }
      >
        <MapView onReadout={onReadout} />
      </View>
      <View
        pointerEvents="box-none"
        style={[
          styles.islandLayer,
          { paddingBottom: insets.bottom + BottomTabInset + Spacing.two },
        ]}
      >
        <CoverageIsland theme={theme} placeName={readout.placeName} coverage={readout.coverage} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mapLayer: {
    ...StyleSheet.absoluteFill,
  },
  islandLayer: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    bottom: 0,
  },
});
