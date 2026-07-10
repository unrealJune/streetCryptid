import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  CoverageIsland,
  MapView,
  useMapTheme,
  type MapFriendLocation,
  type MapReadout,
} from '@/features/map';
import type { LocationFix } from '@/features/social/core/types';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

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
  const { selfFix, hasLiveSelfFix, friends, locationStatus } = useLocationSharing();
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

  const mapFriends = useMemo(
    () =>
      friends.flatMap((presence) =>
        presence.fix
          ? [
              {
                id: presence.friend.endpointId,
                handle: presence.friend.handle,
                location: { lat: presence.fix.lat, lon: presence.fix.lon },
                stale: presence.freshness === 'stale',
              },
            ]
          : []
      ),
    [friends]
  );

  const pct = Math.round(readout.coverage * 100);
  const friendNames = mapFriends.map((friend) => friend.handle).join(', ');
  const locationCopy =
    locationStatus === 'running'
      ? selfFix
        ? 'Your current location is shown.'
        : 'Finding your location.'
      : 'Your location is not available.';

  return (
    <View style={[styles.container, { backgroundColor: theme.chrome.bg }]}>
      <View
        style={styles.mapLayer}
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          readout.placeName
            ? `Map near ${readout.placeName}. ${pct} percent of visible sectors explored. ${locationCopy} ${
                mapFriends.length > 0
                  ? `${mapFriends.length} friend${mapFriends.length === 1 ? '' : 's'} on the map: ${friendNames}.`
                  : 'No friend locations are available.'
              }`
            : 'Map loading.'
        }
      >
        <MapSession
          key={hasLiveSelfFix ? 'gps-centered' : 'default-centered'}
          onReadout={onReadout}
          initialFix={hasLiveSelfFix ? selfFix : null}
          friends={mapFriends}
        />
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

function MapSession({
  initialFix,
  friends,
  onReadout,
}: {
  initialFix: LocationFix | null;
  friends: readonly MapFriendLocation[];
  onReadout(readout: MapReadout): void;
}) {
  const [initialCenter] = useState(() =>
    initialFix ? { lat: initialFix.lat, lon: initialFix.lon } : null
  );

  return (
    <MapView
      onReadout={onReadout}
      initialCenter={initialCenter}
      selfLocation={initialFix ? { lat: initialFix.lat, lon: initialFix.lon } : null}
      friends={friends}
    />
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
