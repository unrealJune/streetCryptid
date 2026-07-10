import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  useColorScheme,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { CryptidProfileEditor } from '@/features/account/components/cryptid-profile-editor';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { useTheme } from '@/hooks/use-theme';
import { CryptidDiscoveryCelebration } from '../components/cryptid-discovery-celebration';
import { FriendProfileSheet } from '../components/friend-profile-sheet';
import { PairLinkAction } from '../components/pair-link-action';
import { formatDistance, formatPresenceAge } from '../core/presence';
import { useLocationSharing } from '../hooks/use-location-sharing';
import { usePairingHaptics } from '../hooks/use-pairing-haptics';
import { useRubToPair } from '../hooks/use-rub-to-pair';

export default function FriendsScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const account = useCryptidProfile();
  const { profile } = account;
  const isFocused = useIsFocused();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const handledPairToken = useRef<string | null>(null);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);

  const {
    snapshot,
    pairing,
    friends,
    locationStatus,
    error,
    setPairingReady,
    beginNearbyGesture,
    createPairInvite,
    pairFromInput,
    respondPair,
    refreshPairing,
    toggleShare,
    retryLocation,
    acknowledgeDiscoveredFriend,
    rejectDiscoveredFriend,
  } = useLocationSharing();

  useFocusEffect(
    useCallback(() => {
      if (!snapshot?.ready) return;
      void setPairingReady(true);
      void refreshPairing();
      return () => {
        void setPairingReady(false);
      };
    }, [refreshPairing, setPairingReady, snapshot?.ready])
  );

  const onRub = useCallback(async () => {
    await beginNearbyGesture();
  }, [beginNearbyGesture]);
  const rub = useRubToPair(
    isFocused && Boolean(pairing?.available) && !pairing?.discoveredFriend,
    onRub
  );
  usePairingHaptics(pairing, isFocused);

  useEffect(() => {
    const token = Array.isArray(params.token) ? params.token[0] : params.token;
    if (!snapshot?.ready || !token || handledPairToken.current === token) return;
    handledPairToken.current = token;
    void pairFromInput(token).finally(() => {
      router.replace('/social');
    });
  }, [pairFromInput, params.token, router, snapshot?.ready]);

  const selected = useMemo(
    () => friends.find((presence) => presence.friend.endpointId === selectedEndpoint) ?? null,
    [friends, selectedEndpoint]
  );
  const sharingWith = snapshot?.sharingWith ?? [];
  const nearbyLabel = pairing?.gestureActive
    ? 'Matching a nearby signal'
    : pairing?.ready
      ? 'Nearby pairing ready'
      : 'Nearby pairing starting';

  return (
    <>
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + Spacing.four,
            paddingBottom: insets.bottom + Spacing.six,
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <ThemedText type="subtitle">Friends</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {friends.length === 0
                ? 'Your nearby social atlas'
                : `${friends.length} cryptid${friends.length === 1 ? '' : 's'} in your atlas`}
            </ThemedText>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Edit my cryptid profile"
            onPress={() => setEditingIdentity(true)}
            style={({ pressed }) => [
              styles.selfButton,
              { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
            ]}
          >
            <CryptidAvatar
              art={profile?.sigil ?? 'unknown'}
              color={chrome.amber}
              name={profile?.cryptidName ?? 'Your cryptid'}
              muted={false}
              style={styles.selfAvatar}
            />
            <ThemedText type="code" style={{ color: chrome.amber }}>
              {profile?.handle ?? '@you'}
            </ThemedText>
          </Pressable>
        </View>

        <View style={[styles.nearby, { borderColor: theme.backgroundSelected }]}>
          <View
            style={[
              styles.nearbyDot,
              { backgroundColor: pairing?.ready ? chrome.green : theme.textSecondary },
            ]}
          />
          <ThemedText type="smallBold">{nearbyLabel}</ThemedText>
          {rub.lastDetectedAt ? (
            <ThemedText type="code" style={[styles.nearbyMotion, { color: chrome.green }]}>
              MOTION FOUND
            </ThemedText>
          ) : null}
        </View>

        {error ? (
          <View style={[styles.notice, { borderColor: chrome.amber }]}>
            <View style={styles.noticeCopy}>
              <ThemedText type="smallBold">
                {locationStatus === 'permission-denied'
                  ? 'Location access is off'
                  : 'Friend sync needs attention'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={2}>
                {locationStatus === 'permission-denied'
                  ? 'Allow background location so your friends stay current.'
                  : error}
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                void (locationStatus === 'permission-denied'
                  ? Linking.openSettings()
                  : retryLocation())
              }
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <ThemedText type="code" style={{ color: chrome.amber }}>
                {locationStatus === 'permission-denied' ? 'SETTINGS' : 'RETRY'}
              </ThemedText>
            </Pressable>
          </View>
        ) : null}

        {friends.length === 0 ? (
          <View style={styles.empty}>
            <ThemedText style={styles.emptyTitle}>No cryptids nearby yet</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.emptyCopy}>
              Keep Friends open on both phones and make the same small back-and-forth or circular
              motion.
            </ThemedText>
          </View>
        ) : (
          <View>
            {friends.map((presence, index) => {
              const distance = formatDistance(presence.distanceM);
              const meta = [distance, formatPresenceAge(presence.ageMs)]
                .filter(Boolean)
                .join(' · ');
              return (
                <Pressable
                  key={presence.friend.endpointId}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${presence.friend.handle}'s profile. ${meta}`}
                  onPress={() => setSelectedEndpoint(presence.friend.endpointId)}
                  style={({ pressed }) => [
                    styles.friendRow,
                    {
                      borderTopColor: theme.backgroundSelected,
                      borderBottomColor:
                        index === friends.length - 1 ? theme.backgroundSelected : 'transparent',
                      opacity: pressed ? 0.58 : 1,
                    },
                  ]}
                >
                  <CryptidAvatar
                    art={presence.friend.sigil || 'unknown'}
                    color={chrome.green}
                    name={presence.friend.cryptidName ?? 'Unknown form'}
                    muted={presence.freshness === 'stale'}
                    style={styles.friendAvatar}
                  />
                  <View style={styles.friendCopy}>
                    <ThemedText type="smallBold" style={{ color: chrome.green }}>
                      {presence.friend.handle}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {meta}
                    </ThemedText>
                  </View>
                  <ThemedText type="code" themeColor="textSecondary">
                    {'>'}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        )}

        {pairing ? (
          <PairLinkAction
            accent={chrome.green}
            pairing={pairing}
            onCreateInvite={createPairInvite}
            onRespond={respondPair}
          />
        ) : null}
      </ScrollView>

      <FriendProfileSheet
        presence={selected}
        visible={selected !== null}
        sharing={selected ? sharingWith.includes(selected.friend.endpointId) : false}
        onClose={() => setSelectedEndpoint(null)}
        onToggleShare={async (on) => {
          if (!selected) return;
          await toggleShare(selected.friend.endpointId, on);
        }}
        onViewMap={() => {
          setSelectedEndpoint(null);
          router.navigate('/');
        }}
      />

      <Modal
        animationType="slide"
        onRequestClose={() => setEditingIdentity(false)}
        presentationStyle="pageSheet"
        visible={editingIdentity && profile !== null}
      >
        {profile ? (
          <CryptidProfileEditor
            initialProfile={profile}
            mode="edit"
            notice={account.error}
            onCancel={() => setEditingIdentity(false)}
            onSave={async (nextProfile) => {
              await account.saveProfile(nextProfile);
              setEditingIdentity(false);
            }}
          />
        ) : null}
      </Modal>

      <CryptidDiscoveryCelebration
        friend={pairing?.discoveredFriend ?? null}
        onAcknowledge={acknowledgeDiscoveredFriend}
        onReject={rejectDiscoveredFriend}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.four,
    paddingHorizontal: Spacing.four,
  },
  header: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
  },
  headerCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  selfButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.one,
    minHeight: 72,
    minWidth: 92,
    padding: Spacing.two,
  },
  selfAvatar: {
    maxHeight: 42,
    overflow: 'hidden',
  },
  nearby: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    minHeight: 48,
  },
  nearbyDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  nearbyMotion: {
    marginLeft: 'auto',
  },
  notice: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Spacing.two,
    flexDirection: 'row',
    gap: Spacing.three,
    padding: Spacing.three,
  },
  noticeCopy: {
    flex: 1,
    gap: Spacing.one,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 220,
    paddingHorizontal: Spacing.four,
  },
  emptyTitle: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 24,
    fontWeight: '600',
    marginBottom: Spacing.two,
  },
  emptyCopy: {
    maxWidth: 320,
    textAlign: 'center',
  },
  friendRow: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 92,
    paddingVertical: Spacing.two,
  },
  friendAvatar: {
    width: 88,
  },
  friendCopy: {
    flex: 1,
    gap: Spacing.one,
    minWidth: 0,
  },
});
