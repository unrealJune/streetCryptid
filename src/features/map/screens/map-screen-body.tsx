import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing, TopTabInset } from '@/constants/theme';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
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
import type { LocationFix } from '@/features/social/core/types';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { SELF_AUTHOR, type TrailPoint } from '@/features/social/net/background/trail-store';

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
  const { profile } = useCryptidProfile();
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
            history: trailLocations(sampled),
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
  const selfHistory = useMemo(() => {
    const history = selectFriendTrail(trail, SELF_AUTHOR);
    const sampled = sampleTrailForMap(history);
    return {
      history,
      sampled: trailLocations(sampled),
    };
  }, [trail]);
  const selfMapLocation = useMemo<MapFriendLocation | null>(() => {
    if (!selfFix || !profile) return null;
    return {
      id: SELF_AUTHOR,
      handle: profile.handle,
      sigil: profile.sigil,
      cryptidName: profile.cryptidName,
      color: `rgb(${theme.canvas.accent.join(', ')})`,
      location: { lat: selfFix.lat, lon: selfFix.lon },
      history: selfHistory.sampled,
      historyCount: selfHistory.history.length,
      latestTs: selfFix.ts,
    };
  }, [profile, selfFix, selfHistory, theme.canvas.accent]);
  const selectedHistory = selectedEndpoint === SELF_AUTHOR ? selfMapLocation : selectedFriend;

  const closeHistory = useCallback(() => {
    setSelection((current) => ({ ...current, selectedId: null }));
    if (requestedFriendId) router.setParams({ friend: undefined });
  }, [requestedFriendId, router]);
  const selectFriend = useCallback((friendId: string) => {
    setSelection((current) => ({ ...current, selectedId: friendId }));
  }, []);
  const selectSelf = useCallback(() => {
    setSelection((current) => ({ ...current, selectedId: SELF_AUTHOR }));
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
  // Once we have ever had a live self fix, the map stays self-anchored.
  // A fix going stale later must not recenter the session out from under the user.
  const [selfCenterSeen, setSelfCenterSeen] = useState(false);
  if (!selfCenterSeen && hasLiveSelfFix && selfFix) setSelfCenterSeen(true);
  // `useMapEngine` fixes its session anchor at mount, so the map opens on the
  // dataset's fallback home and re-anchors on the user when the first fix lands.
  // Keying on `selfCenterSeen` makes that re-anchor happen exactly once, whenever
  // the fix arrives — there is no deadline to wait out, and no blank map if a fix
  // never comes at all. Later fixes move the marker without moving the camera.
  const mapSessionKey = sessionFocus
    ? `friend-${sessionFocus.id}`
    : selfCenterSeen
      ? 'self-anchored'
      : 'fallback-anchored';
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
          onSelectSelf={selectSelf}
          friends={mapFriends}
          selectedFriendId={selectedEndpoint === SELF_AUTHOR ? null : selectedEndpoint}
          selfHistory={selfHistory.sampled}
          selfSelected={selectedEndpoint === SELF_AUTHOR}
          selfLocation={hasLiveSelfFix && selfFix ? { lat: selfFix.lat, lon: selfFix.lon } : null}
          selfFix={hasLiveSelfFix ? selfFix : null}
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
        {selectedHistory ? (
          <FriendHistoryIsland
            friend={selectedHistory}
            onClose={closeHistory}
            self={selectedEndpoint === SELF_AUTHOR}
            theme={theme}
          />
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
  selfFix,
  friends,
  selectedFriendId,
  explorationEnabled,
  onReadout,
  onSelectFriend,
  onSelectSelf,
  selfHistory,
  selfSelected,
}: {
  accessibilityLabel: string;
  initialCenter: MapFriendLocation['location'] | null;
  selfLocation: MapFriendLocation['location'] | null;
  selfFix: LocationFix | null;
  friends: readonly MapFriendLocation[];
  selectedFriendId: string | null;
  explorationEnabled: boolean;
  onReadout(readout: MapReadout): void;
  onSelectFriend(friendId: string): void;
  onSelectSelf(): void;
  selfHistory: MapFriendLocation['history'];
  selfSelected: boolean;
}) {
  const [sessionCenter] = useState(initialCenter);

  return (
    <MapView
      accessibilityLabel={accessibilityLabel}
      explorationEnabled={explorationEnabled}
      onReadout={onReadout}
      initialCenter={sessionCenter}
      onSelectFriend={onSelectFriend}
      onSelectSelf={onSelectSelf}
      friends={friends}
      selectedFriendId={selectedFriendId}
      selfHistory={selfHistory}
      selfLocation={selfLocation}
      selfFix={selfFix}
      selfSelected={selfSelected}
    />
  );
}

function trailLocations(points: readonly TrailPoint[]): MapFriendLocation['history'] {
  return points.map((point) => ({
    id: `${point.author}:${point.seq}`,
    location: { lat: point.fix.lat, lon: point.fix.lon },
  }));
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
