import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing } from '@/constants/theme';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import {
  CoverageIsland,
  FriendHistoryIsland,
  FriendsIsland,
  hexToRgb,
  LocateMeControl,
  MapIsland,
  MapLayersControl,
  MapView,
  rgbToHex,
  SettingsControl,
  useMapTheme,
  type IslandTab,
  type MapFriendLocation,
  type MapReadout,
  type MapLayerId,
  type MapLayerToggles,
  type MapRosterFriend,
  type Rgb,
} from '@/features/map';
import { BumpPairingStrip } from '@/features/social/components/bump-pairing-strip';
import { FriendProfileSheet } from '@/features/social/components/friend-profile-sheet';
import { sampleTrailForMap, selectFriendTrail } from '@/features/social/core/history';
import { formatPresenceAge } from '@/features/social/core/presence';
import type { LocationFix } from '@/features/social/core/types';
import { useArmedBump } from '@/features/social/hooks/use-armed-bump';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { SELF_AUTHOR, type TrailPoint } from '@/features/social/net/background/trail-store';

/**
 * The map IS the product: full-bleed dot field with a single floating bottom
 * island. The island doubles as the accessible text model for the canvas.
 *
 * There is no tab bar and no header. Everything else in the app is either an
 * island over this canvas, a sheet pulled over it, or Settings behind the one
 * piece of top chrome.
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
  const params = useLocalSearchParams<{
    friend?: string | string[];
    pair?: string | string[];
  }>();
  const requestedFriendId = Array.isArray(params.friend) ? params.friend[0] : params.friend;
  const pairToken = Array.isArray(params.pair) ? params.pair[0] : params.pair;
  const {
    selfFix,
    hasLiveSelfFix,
    trail,
    friends,
    locationStatus,
    snapshot,
    pairFromInput,
    toggleShare,
    toggleWatch,
    stopWatcher,
    removeFriend,
  } = useLocationSharing();
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
  const [layers, setLayers] = useState<MapLayerToggles>({
    exploration: true,
    highways: true,
    transit: false,
  });
  const explorationEnabled = layers.exploration;
  const setLayer = useCallback((layer: MapLayerId, enabled: boolean) => {
    setLayers((current) => ({ ...current, [layer]: enabled }));
  }, []);
  const [islandTab, setIslandTab] = useState<IslandTab>('me');
  const [profileEndpoint, setProfileEndpoint] = useState<string | null>(null);
  const [locateTarget, setLocateTarget] = useState<{
    requestId: number;
    location: MapFriendLocation['location'];
  } | null>(null);
  const [readout, setReadout] = useState<{
    placeName: string | null;
    coverage: number;
    sectorsVisible: boolean;
  }>({
    placeName: null,
    coverage: 0,
    sectorsVisible: true,
  });

  const onReadout = useCallback((next: MapReadout) => {
    setReadout((current) =>
      current.placeName === next.placeName &&
      current.coverage === next.coverage &&
      current.sectorsVisible === next.sectorsVisible
        ? current
        : {
            placeName: next.placeName,
            coverage: next.coverage,
            sectorsVisible: next.sectorsVisible,
          }
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
  // The roster carries EVERY friend, not just the ones with a fix — a friend who
  // has gone dark should dim in place rather than silently vanish from the list.
  const rosterFriends = useMemo<MapRosterFriend[]>(
    () =>
      friends.map((presence) => ({
        id: presence.friend.endpointId,
        handle: presence.friend.handle,
        sigil: presence.friend.sigil,
        cryptidName: presence.friend.cryptidName,
        color: resolveSignalColor(presence.friend.color, theme.chrome.green),
        distanceM: presence.distanceM,
        status: formatPresenceAge(presence.ageMs).toUpperCase(),
        online: presence.freshness === 'live' || presence.freshness === 'recent',
        locatable: presence.fix !== null,
      })),
    [friends, theme.chrome.green]
  );
  // Your own signal is the SAME color your friends already see for you — the one
  // you picked in Settings. The theme accent is only the pre-profile fallback,
  // which keeps amber for the frontier rim rather than for you.
  const selfSignal = useMemo(
    () => resolveSignalColor(profile?.color, rgbToHex(theme.canvas.accent)),
    [profile?.color, theme.canvas.accent]
  );
  const selfInk = useMemo(
    () => hexToRgb(selfSignal, theme.canvas.accent),
    [selfSignal, theme.canvas.accent]
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
      color: selfSignal,
      location: { lat: selfFix.lat, lon: selfFix.lon },
      history: selfHistory.sampled,
      historyCount: selfHistory.history.length,
      latestTs: selfFix.ts,
    };
  }, [profile, selfFix, selfHistory, selfSignal]);
  const selectedHistory = selectedEndpoint === SELF_AUTHOR ? selfMapLocation : selectedFriend;
  // A selected trace is a drill-down *inside* the FRIENDS tab, not a third tab:
  // the roster is only actually on screen when nothing is drilled into. This is
  // also what arms bump pairing, so the radio never runs behind a trace island.
  const rosterOpen = islandTab === 'friends' && !selectedHistory;
  const bump = useArmedBump(rosterOpen);

  const closeHistory = useCallback(() => {
    setSelection((current) => ({ ...current, selectedId: null }));
    if (requestedFriendId) router.setParams({ friend: undefined });
  }, [requestedFriendId, router]);
  // Tapping a locator toggles its trace island: re-tapping the one already open
  // closes it, exactly like the island's X. Tapping a DIFFERENT locator still
  // swaps straight to it rather than closing, so moving between friends is one
  // tap, not two. Closing clears the `?friend=` param for the same reason
  // `closeHistory` does — otherwise a deep-linked friend leaves a stale param
  // that the route-change check would not fire on again.
  const toggleSelection = useCallback(
    (id: string) => {
      if (selectedEndpoint !== id) {
        setIslandTab('me');
        setSelection((current) => ({ ...current, selectedId: id }));
        return;
      }
      setSelection((current) => ({ ...current, selectedId: null }));
      if (requestedFriendId) router.setParams({ friend: undefined });
    },
    [requestedFriendId, router, selectedEndpoint]
  );
  const selectFriend = useCallback(
    (friendId: string) => toggleSelection(friendId),
    [toggleSelection]
  );
  const selectSelf = useCallback(() => toggleSelection(SELF_AUTHOR), [toggleSelection]);
  const locateSelf = useCallback(() => {
    if (!selfFix) return;
    setLocateTarget((current) => ({
      requestId: (current?.requestId ?? 0) + 1,
      location: { lat: selfFix.lat, lon: selfFix.lon },
    }));
  }, [selfFix]);
  // The island's segmented bar is the app's only navigation. Either tab also
  // dismisses whatever trace was drilled into, so the bar can never look dead —
  // and so tapping the tab you are already "on" is a way back out of a trace.
  const selectIslandTab = useCallback(
    (tab: IslandTab) => {
      closeHistory();
      setIslandTab(tab);
    },
    [closeHistory]
  );
  // Tapping a roster row is the same gesture as tapping the locator: fly there
  // and open the trace. The roster steps aside so the map it just moved is
  // visible, but the FRIENDS tab stays lit — you drilled in from there, and
  // closing the trace should put you back on the roster, not on ME.
  const focusRosterFriend = useCallback(
    (friendId: string) => {
      const target = mapFriends.find((friend) => friend.id === friendId);
      if (!target) return;
      setIslandTab('friends');
      setSelection((current) => ({ ...current, selectedId: friendId }));
      setLocateTarget((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        location: target.location,
      }));
    },
    [mapFriends]
  );

  const profilePresence = useMemo(
    () => friends.find((presence) => presence.friend.endpointId === profileEndpoint) ?? null,
    [friends, profileEndpoint]
  );
  const profileHistory = useMemo(
    () => (profilePresence ? selectFriendTrail(trail, profilePresence.friend.endpointId) : []),
    [profilePresence, trail]
  );

  // A `streetcryptid://…?token=` invite lands here now that the Friends route is
  // gone. Redeem it once, show the roster so the handshake has somewhere to land,
  // then drop the token from the URL so a re-render cannot replay it.
  const redeemedPairToken = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot?.ready || !pairToken || redeemedPairToken.current === pairToken) return;
    redeemedPairToken.current = pairToken;
    selectIslandTab('friends');
    void pairFromInput(pairToken)
      .catch(() => {
        // The provider surfaces the actionable error; consume the rejection here.
      })
      .finally(() => {
        router.setParams({ pair: undefined });
      });
  }, [pairFromInput, pairToken, router, selectIslandTab, snapshot?.ready]);

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
      } ${layers.highways ? 'Highways shown.' : 'Highways hidden.'} ${
        layers.transit ? 'Transit overlay on.' : 'Transit overlay off.'
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
  // The island floats clear of the system gesture bar on BOTH platforms. Android
  // used to be special-cased to ignore the bottom inset because the native tab
  // bar consumed it — there is no tab bar any more, so ignoring it parks the
  // segmented bar right on top of the gesture handle. `Spacing.three` matches the
  // island's own side inset, so it sits in a square margin rather than a slot.
  const islandBottomPadding = insets.bottom + Spacing.three;

  return (
    <View style={[styles.container, { backgroundColor: theme.chrome.bg }]}>
      <View style={styles.mapLayer}>
        <MapSession
          accessibilityLabel={mapAccessibilityLabel}
          explorationEnabled={explorationEnabled}
          highwaysEnabled={layers.highways}
          transitEnabled={layers.transit}
          key={mapSessionKey}
          onReadout={onReadout}
          initialCenter={initialCenter}
          locateTarget={locateTarget}
          onSelectFriend={selectFriend}
          onSelectSelf={selectSelf}
          friends={mapFriends}
          selectedFriendId={selectedEndpoint === SELF_AUTHOR ? null : selectedEndpoint}
          selfHistory={selfHistory.sampled}
          selfSelected={selectedEndpoint === SELF_AUTHOR}
          selfColor={selfInk}
          selfLocation={hasLiveSelfFix && selfFix ? { lat: selfFix.lat, lon: selfFix.lon } : null}
          selfFix={hasLiveSelfFix ? selfFix : null}
        />
      </View>
      {/* The app's only top chrome: attribution on the left, Settings on the right.
          `pointerEvents="box-none"` so the empty span between them still pans the map. */}
      <View pointerEvents="box-none" style={[styles.topLayer, { top: insets.top + Spacing.three }]}>
        <Text
          pointerEvents="none"
          style={[styles.attribution, { color: theme.chrome.steel }]}
          numberOfLines={1}
        >
          © OPENSTREETMAP
        </Text>
        <SettingsControl onPress={() => router.push('/settings')} theme={theme} />
      </View>
      {/* Only map affordances float now: layers and locate. Switching what the
          island is about belongs to the island's own segmented bar, so the map's
          corners stay about the map. */}
      <View
        pointerEvents="box-none"
        style={[styles.islandLayer, { paddingBottom: islandBottomPadding }]}
      >
        <View pointerEvents="box-none" style={styles.controls}>
          <MapLayersControl layers={layers} onChange={setLayer} theme={theme} />
          <LocateMeControl
            disabled={!hasLiveSelfFix || !selfFix}
            onPress={locateSelf}
            theme={theme}
          />
        </View>
        <MapIsland active={islandTab} onSelect={selectIslandTab} signal={selfSignal} theme={theme}>
          {selectedHistory ? (
            <FriendHistoryIsland
              friend={selectedHistory}
              onClose={closeHistory}
              self={selectedEndpoint === SELF_AUTHOR}
              theme={theme}
            />
          ) : rosterOpen ? (
            <FriendsIsland
              friends={rosterFriends}
              onOpenProfile={setProfileEndpoint}
              onSelect={focusRosterFriend}
              pairing={
                <BumpPairingStrip
                  error={bump.error}
                  onArm={bump.arm}
                  onCommit={bump.commit}
                  pairing={bump.pairing}
                  sensor={bump.sensor}
                  theme={theme}
                />
              }
              theme={theme}
            />
          ) : (
            <CoverageIsland
              coverage={readout.coverage}
              placeName={readout.placeName}
              sectorsVisible={readout.sectorsVisible}
              signal={selfSignal}
              theme={theme}
            />
          )}
        </MapIsland>
      </View>

      <FriendProfileSheet
        history={profileHistory}
        presence={profilePresence}
        visible={profilePresence !== null}
        sharing={
          profilePresence
            ? (snapshot?.sharingWith ?? []).includes(profilePresence.friend.endpointId)
            : false
        }
        watching={
          profilePresence
            ? (snapshot?.live.watching ?? []).includes(profilePresence.friend.endpointId)
            : false
        }
        watchedUntil={
          profilePresence
            ? ((snapshot?.live.watchers ?? []).find(
                (w) => w.author === profilePresence.friend.endpointId
              )?.expiresAt ?? null)
            : null
        }
        onClose={() => setProfileEndpoint(null)}
        onToggleShare={async (on) => {
          if (!profilePresence) return;
          await toggleShare(profilePresence.friend.endpointId, on);
        }}
        onToggleWatch={async (on) => {
          if (!profilePresence) return;
          await toggleWatch(profilePresence.friend.endpointId, on);
        }}
        onStopWatcher={async () => {
          if (!profilePresence) return;
          await stopWatcher(profilePresence.friend.endpointId);
        }}
        onViewMap={() => {
          if (!profilePresence) return;
          const endpointId = profilePresence.friend.endpointId;
          setProfileEndpoint(null);
          focusRosterFriend(endpointId);
        }}
        onRemove={async () => {
          if (!profilePresence) return;
          await removeFriend(profilePresence.friend.endpointId);
          setProfileEndpoint(null);
        }}
      />
    </View>
  );
}

function MapSession({
  accessibilityLabel,
  initialCenter,
  locateTarget,
  selfLocation,
  selfFix,
  friends,
  selectedFriendId,
  explorationEnabled,
  highwaysEnabled,
  transitEnabled,
  onReadout,
  onSelectFriend,
  onSelectSelf,
  selfHistory,
  selfSelected,
  selfColor,
}: {
  accessibilityLabel: string;
  initialCenter: MapFriendLocation['location'] | null;
  locateTarget: { requestId: number; location: MapFriendLocation['location'] } | null;
  selfLocation: MapFriendLocation['location'] | null;
  selfFix: LocationFix | null;
  friends: readonly MapFriendLocation[];
  selectedFriendId: string | null;
  explorationEnabled: boolean;
  highwaysEnabled: boolean;
  transitEnabled: boolean;
  onReadout(readout: MapReadout): void;
  onSelectFriend(friendId: string): void;
  onSelectSelf(): void;
  selfHistory: MapFriendLocation['history'];
  selfSelected: boolean;
  selfColor: Rgb;
}) {
  const [sessionCenter] = useState(initialCenter);

  return (
    <MapView
      accessibilityLabel={accessibilityLabel}
      explorationEnabled={explorationEnabled}
      highwaysEnabled={highwaysEnabled}
      transitEnabled={transitEnabled}
      onReadout={onReadout}
      initialCenter={sessionCenter}
      locateTarget={locateTarget}
      onSelectFriend={onSelectFriend}
      onSelectSelf={onSelectSelf}
      friends={friends}
      selectedFriendId={selectedFriendId}
      selfHistory={selfHistory}
      selfLocation={selfLocation}
      selfFix={selfFix}
      selfSelected={selfSelected}
      selfColor={selfColor}
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
  controls: {
    alignItems: 'flex-end',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  topLayer: {
    position: 'absolute',
    left: Spacing.three,
    right: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  attribution: {
    flexShrink: 1,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    letterSpacing: 1.2,
    opacity: 0.55,
  },
});
