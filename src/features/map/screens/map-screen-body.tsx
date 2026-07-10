import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing, TopTabInset } from '@/constants/theme';
import {
  CoverageIsland,
  FriendHistoryIsland,
  MapLayersControl,
  MapView,
  useMapTheme,
  type MapFriendLocation,
  type MapReadout,
} from '@/features/map';
import { sampleTrailForMap, selectFriendTrail } from '@/features/social/core/history';
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
  const router = useRouter();
  const params = useLocalSearchParams<{ friend?: string | string[] }>();
  const requestedFriendId = Array.isArray(params.friend) ? params.friend[0] : params.friend;
  const { selfFix, hasLiveSelfFix, trail, friends, locationStatus } = useLocationSharing();
  const routeFriendId = requestedFriendId ?? null;
  const [selection, setSelection] = useState(() => ({
    requestId: routeFriendId,
    selectedId: routeFriendId,
    sessionFocusId: routeFriendId,
  }));
  if (routeFriendId !== selection.requestId) {
    setSelection({
      requestId: routeFriendId,
      selectedId: routeFriendId,
      sessionFocusId: routeFriendId ?? selection.sessionFocusId,
    });
  }
  const selectedEndpoint = selection.selectedId;
  const [explorationEnabled, setExplorationEnabled] = useState(true);
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
      friends.flatMap((presence) => {
        if (!presence.fix) return [];
        const history = selectFriendTrail(trail, presence.friend.endpointId);
        const sampled = sampleTrailForMap(history);
        return [
          {
            id: presence.friend.endpointId,
            handle: presence.friend.handle,
            sigil: presence.friend.sigil,
            cryptidName: presence.friend.cryptidName,
            color: resolveSignalColor(presence.friend.color, theme.chrome.green),
            location: { lat: presence.fix.lat, lon: presence.fix.lon },
            history: sampled.map((point) => ({
              lat: point.fix.lat,
              lon: point.fix.lon,
            })),
            historyCount: history.length,
            latestTs: presence.fix.ts,
            stale: presence.freshness === 'stale',
          },
        ];
      }),
    [friends, theme.chrome.green, trail]
  );
  const selectedFriend = useMemo(
    () => mapFriends.find((friend) => friend.id === selectedEndpoint) ?? null,
    [mapFriends, selectedEndpoint]
  );

  const closeHistory = useCallback(() => {
    setSelection((current) => ({ ...current, selectedId: null }));
    if (requestedFriendId) router.setParams({ friend: undefined });
  }, [requestedFriendId, router]);
  const selectFriend = useCallback((friendId: string) => {
    setSelection((current) => ({ ...current, selectedId: friendId }));
  }, []);

  const pct = Math.round(readout.coverage * 100);
  const friendNames = mapFriends.map((friend) => friend.handle).join(', ');
  const locationCopy =
    locationStatus === 'running'
      ? selfFix
        ? 'Your current location is shown.'
        : 'Finding your location.'
      : 'Your location is not available.';
  const mapAccessibilityLabel = readout.placeName
    ? `Map near ${readout.placeName}. ${pct} percent of visible sectors explored. ${
        explorationEnabled ? 'Exploration overlay on.' : 'Exploration overlay off.'
      } ${locationCopy} ${
        mapFriends.length > 0
          ? `${mapFriends.length} friend${mapFriends.length === 1 ? '' : 's'} on the map: ${friendNames}.`
          : 'No friend locations are available.'
      }`
    : 'Map loading.';
  const sessionFocus = selection.sessionFocusId
    ? (mapFriends.find((friend) => friend.id === selection.sessionFocusId) ?? null)
    : null;
  const initialCenter =
    sessionFocus?.location ??
    (hasLiveSelfFix && selfFix ? { lat: selfFix.lat, lon: selfFix.lon } : null);
  const mapSessionKey = sessionFocus
    ? `friend-${sessionFocus.id}`
    : hasLiveSelfFix
      ? 'gps-centered'
      : 'default-centered';
  // Native tabs already apply Android's bottom inset to their screen content.
  const islandBottomPadding = Platform.OS === 'android' ? Spacing.two : insets.bottom + Spacing.two;

  return (
    <View style={[styles.container, { backgroundColor: theme.chrome.bg }]}>
      <View style={styles.mapLayer}>
        <MapSession
          accessibilityLabel={mapAccessibilityLabel}
          explorationEnabled={explorationEnabled}
          key={mapSessionKey}
          onReadout={onReadout}
          initialCenter={initialCenter}
          onSelectFriend={selectFriend}
          friends={mapFriends}
          selectedFriendId={selectedEndpoint}
          selfLocation={hasLiveSelfFix && selfFix ? { lat: selfFix.lat, lon: selfFix.lon } : null}
        />
      </View>
      <View
        pointerEvents="box-none"
        style={[styles.controlsLayer, { top: insets.top + TopTabInset + Spacing.three }]}
      >
        <MapLayersControl
          enabled={explorationEnabled}
          onChange={setExplorationEnabled}
          theme={theme}
        />
      </View>
      <View
        pointerEvents="box-none"
        style={[styles.islandLayer, { paddingBottom: islandBottomPadding }]}
      >
        {selectedFriend ? (
          <FriendHistoryIsland friend={selectedFriend} onClose={closeHistory} theme={theme} />
        ) : (
          <CoverageIsland coverage={readout.coverage} placeName={readout.placeName} theme={theme} />
        )}
      </View>
    </View>
  );
}

function MapSession({
  accessibilityLabel,
  initialCenter,
  selfLocation,
  friends,
  selectedFriendId,
  explorationEnabled,
  onReadout,
  onSelectFriend,
}: {
  accessibilityLabel: string;
  initialCenter: MapFriendLocation['location'] | null;
  selfLocation: MapFriendLocation['location'] | null;
  friends: readonly MapFriendLocation[];
  selectedFriendId: string | null;
  explorationEnabled: boolean;
  onReadout(readout: MapReadout): void;
  onSelectFriend(friendId: string): void;
}) {
  const [sessionCenter] = useState(initialCenter);

  return (
    <MapView
      accessibilityLabel={accessibilityLabel}
      explorationEnabled={explorationEnabled}
      onReadout={onReadout}
      initialCenter={sessionCenter}
      onSelectFriend={onSelectFriend}
      friends={friends}
      selectedFriendId={selectedFriendId}
      selfLocation={selfLocation}
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
  controlsLayer: {
    position: 'absolute',
    right: Spacing.three,
  },
});
