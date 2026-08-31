import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveSignalColor } from '@/constants/signal-colors';
import { Spacing } from '@/constants/theme';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import {
  CoverageIsland,
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
  type MapTrailLocation,
  type MapReadout,
  type MapLayerId,
  type MapLayerToggles,
  type MapRosterFriend,
  type Rgb,
} from '@/features/map';
import { sampleTrailForMap } from '@/features/map/core/trail-sampling';
import { BumpPairingStrip } from '@/features/social/components/bump-pairing-strip';
import { FriendProfileSheet } from '@/features/social/components/friend-profile-sheet';
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
    dev?: string | string[];
    devId?: string | string[];
  }>();
  const requestedFriendId = Array.isArray(params.friend) ? params.friend[0] : params.friend;
  const pairToken = Array.isArray(params.pair) ? params.pair[0] : params.pair;
  const devCommand = Array.isArray(params.dev) ? params.dev[0] : params.dev;
  const devCommandId = Array.isArray(params.devId) ? params.devId[0] : params.devId;
  const {
    selfFix,
    hasLiveSelfFix,
    trail,
    friends,
    locationStatus,
    snapshot,
    locateNow,
    pairFromInput,
    toggleShare,
    removeFriend,
    runDevCommand,
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
        return [
          {
            id: presence.friend.endpointId,
            handle: presence.friend.handle,
            sigil: presence.friend.sigil,
            cryptidName: presence.friend.cryptidName,
            color: resolveSignalColor(presence.friend.color, theme.chrome.green),
            location: { lat: presence.fix.lat, lon: presence.fix.lon },
            latestTs: presence.fix.ts,
            stale: presence.freshness === 'stale',
          },
        ];
      }),
    [friends, theme.chrome.green]
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
  // `trail` is our OWN retained trail — friends carry a current fix and nothing behind it.
  const selfHistory = useMemo(() => trailLocations(sampleTrailForMap(trail)), [trail]);
  // Selecting a locator highlights it (and draws OUR trail when it is us). The roster is on
  // screen whenever the FRIENDS tab is up; it is also what arms bump pairing.
  const rosterOpen = islandTab === 'friends';
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
  // Ask where the user is as soon as the map exists, so their own marker and the opening camera
  // stop waiting on the sharing pipeline too — `initialCenter` and `selfLocation` below are gated
  // on `hasLiveSelfFix`, which nothing but a publish used to set. `prompt: false` keeps this
  // silent when permission has not been granted yet: the OS dialog must never precede the in-app
  // disclosure screen, and the locate button is the user-initiated path that may ask.
  useEffect(() => {
    void locateNow({ prompt: false });
  }, [locateNow]);

  const [locating, setLocating] = useState(false);
  /**
   * Take the user to where they are. Always — this is a map control, not a sharing control.
   *
   * It used to be disabled until `hasLiveSelfFix`, which is only set by something reaching the
   * PUBLISH path, so a freshly installed and correctly paired app sat with the button greyed out
   * because it had never sealed a fix. "Where am I" and "have I told anyone where I am" are
   * different questions, and only the second one needs the pipeline.
   *
   * Centres on what we already know first, so a press with a known position is instant, then asks
   * the OS and re-centres if the answer moved. From cold there is nothing to show first and the
   * read is the whole of it, which is what the spinner is for.
   */
  const locateSelf = useCallback(() => {
    if (selfFix) {
      setLocateTarget((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        location: { lat: selfFix.lat, lon: selfFix.lon },
      }));
    }
    setLocating(true);
    void locateNow()
      .then((fix) => {
        if (!fix) return;
        setLocateTarget((current) => ({
          requestId: (current?.requestId ?? 0) + 1,
          location: { lat: fix.lat, lon: fix.lon },
        }));
      })
      .finally(() => setLocating(false));
  }, [selfFix, locateNow]);
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

  // `streetcryptid://dev?cmd=…&id=…` — the e2e harness driving a RUNNING app (see
  // `features/dev/commands`). Dispatch keys off the `id` nonce rather than the command name, so
  // issuing the same command twice fires twice; clearing the params afterwards stops a re-render
  // from replaying it, exactly like the pair token above.
  const ranDevCommandId = useRef<string | null>(null);
  useEffect(() => {
    // Waiting on `ready` is what makes the acknowledgement worth more than `assertVisible`: it
    // says the sharing service answered, not that a view painted. A cold start opened by the
    // link therefore acknowledges once it can actually do the work, and a device that never gets
    // there times out in the harness with its event log dumped.
    if (!snapshot?.ready || !devCommand || !devCommandId) return;
    if (ranDevCommandId.current === devCommandId) return;
    ranDevCommandId.current = devCommandId;
    void runDevCommand(devCommand, devCommandId).finally(() => {
      router.setParams({ dev: undefined, devId: undefined });
    });
  }, [devCommand, devCommandId, router, runDevCommand, snapshot?.ready]);

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
          selfHistory={selfHistory}
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
          <LocateMeControl busy={locating} onPress={locateSelf} theme={theme} />
        </View>
        <MapIsland active={islandTab} onSelect={selectIslandTab} signal={selfSignal} theme={theme}>
          {rosterOpen ? (
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
        presence={profilePresence}
        visible={profilePresence !== null}
        sharing={
          profilePresence
            ? (snapshot?.sharingWith ?? []).includes(profilePresence.friend.endpointId)
            : false
        }
        ratchetActivity={
          profilePresence ? snapshot?.ratchetActivity[profilePresence.friend.endpointId] : undefined
        }
        onClose={() => setProfileEndpoint(null)}
        onToggleShare={async (on) => {
          if (!profilePresence) return;
          await toggleShare(profilePresence.friend.endpointId, on);
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
  selfHistory: readonly MapTrailLocation[];
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

function trailLocations(points: readonly TrailPoint[]): MapTrailLocation[] {
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
