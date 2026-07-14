import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
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
import { resolveSignalColor } from '@/constants/signal-colors';
import { CryptidThemes, Spacing, TopTabInset } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { CryptidProfileEditor } from '@/features/account/components/cryptid-profile-editor';
import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { useTheme } from '@/hooks/use-theme';
import { BumpPairingPanel } from '../components/bump-pairing-panel';
import { CryptidDiscoveryCelebration } from '../components/cryptid-discovery-celebration';
import { FriendProfileSheet } from '../components/friend-profile-sheet';
import { PairLinkAction } from '../components/pair-link-action';
import { PairingVerificationPanel } from '../components/pairing-verification-panel';
import { selectFriendTrail } from '../core/history';
import { formatDistance, formatPresenceAge } from '../core/presence';
import { useBumpToPair } from '../hooks/use-bump-to-pair';
import { useLocationSharing } from '../hooks/use-location-sharing';
import { usePairingHaptics } from '../hooks/use-pairing-haptics';

export default function FriendsScreen() {
  const theme = useTheme();
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const insets = useSafeAreaInsets();
  const account = useCryptidProfile();
  const { profile } = account;
  const selfSignalColor = resolveSignalColor(profile?.color, chrome.amber);
  const isFocused = useIsFocused();
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const isInteractive = isFocused && appState === 'active';
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const handledPairToken = useRef<string | null>(null);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);

  const {
    snapshot,
    pairing,
    trail,
    friends,
    locationStatus,
    error,
    armBump,
    commitBump,
    cancelBump,
    createPairInvite,
    pairFromInput,
    respondPair,
    submitPairChoice,
    confirmPairDisplay,
    cancelPair,
    toggleShare,
    removeFriend,
    retryLocation,
    acknowledgeDiscoveredFriend,
    rejectDiscoveredFriend,
  } = useLocationSharing();
  const bumpStage = pairing?.bump.stage;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (isInteractive || bumpStage === undefined || bumpStage === 'idle') return;
    void cancelBump();
  }, [bumpStage, cancelBump, isInteractive]);

  const onBump = useCallback(async () => {
    await commitBump();
  }, [commitBump]);
  const bumpSensor = useBumpToPair(
    isInteractive && pairing?.bump.stage === 'armed' && !pairing.discoveredFriend,
    onBump
  );
  usePairingHaptics(pairing, isInteractive);

  useEffect(() => {
    const token = Array.isArray(params.token) ? params.token[0] : params.token;
    if (!snapshot?.ready || !token || handledPairToken.current === token) return;
    handledPairToken.current = token;
    void pairFromInput(token)
      .catch(() => {
        // The provider surfaces the actionable error; consume the rejection from the route effect.
      })
      .finally(() => {
        router.replace('/social');
      });
  }, [pairFromInput, params.token, router, snapshot?.ready]);

  const selected = useMemo(
    () => friends.find((presence) => presence.friend.endpointId === selectedEndpoint) ?? null,
    [friends, selectedEndpoint]
  );
  const selectedHistory = useMemo(
    () => (selected ? selectFriendTrail(trail, selected.friend.endpointId) : []),
    [selected, trail]
  );
  const sharingWith = snapshot?.sharingWith ?? [];
  return (
    <>
      <ScrollView
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + TopTabInset + Spacing.four,
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
              color={selfSignalColor}
              name={profile?.cryptidName ?? 'Your cryptid'}
              muted={false}
              style={styles.selfAvatar}
            />
            <ThemedText type="code" style={{ color: selfSignalColor }}>
              {profile?.handle ?? '@you'}
            </ThemedText>
          </Pressable>
        </View>

        <BumpPairingPanel
          accent={chrome.green}
          pairing={pairing}
          sensor={bumpSensor}
          onArm={armBump}
          onCommit={commitBump}
          onCancel={cancelBump}
        />

        {pairing?.verifications.length ? (
          <PairingVerificationPanel
            accent={chrome.green}
            verifications={pairing.verifications}
            onChoose={submitPairChoice}
            onConfirm={confirmPairDisplay}
            onCancel={cancelPair}
          />
        ) : null}

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

        {friends.length === 0 && !pairing?.verifications.length ? (
          <View style={styles.empty}>
            <ThemedText style={styles.emptyTitle}>No cryptids nearby yet</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.emptyCopy}>
              Arm Bump on both phones, tap their top edges together, then compare the ASCII figure
              shown on both screens.
            </ThemedText>
          </View>
        ) : (
          <View>
            {friends.map((presence, index) => {
              const distance = formatDistance(presence.distanceM);
              const meta = [distance, formatPresenceAge(presence.ageMs)]
                .filter(Boolean)
                .join(' · ');
              const signalColor = resolveSignalColor(presence.friend.color, chrome.green);
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
                    color={signalColor}
                    name={presence.friend.cryptidName ?? 'Unknown form'}
                    muted={presence.freshness === 'stale'}
                    style={styles.friendAvatar}
                  />
                  <View style={styles.friendCopy}>
                    <ThemedText type="smallBold">{presence.friend.handle}</ThemedText>
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
            errorAccent={chrome.amber}
            pairing={pairing}
            onCreateInvite={createPairInvite}
            onPairInput={pairFromInput}
            onReject={(sessionId) => respondPair(sessionId, false)}
          />
        ) : null}
      </ScrollView>

      <FriendProfileSheet
        history={selectedHistory}
        presence={selected}
        visible={selected !== null}
        sharing={selected ? sharingWith.includes(selected.friend.endpointId) : false}
        onClose={() => setSelectedEndpoint(null)}
        onToggleShare={async (on) => {
          if (!selected) return;
          await toggleShare(selected.friend.endpointId, on);
        }}
        onViewMap={() => {
          if (!selected) return;
          setSelectedEndpoint(null);
          router.navigate({
            pathname: '/',
            params: { friend: selected.friend.endpointId },
          });
        }}
        onRemove={async () => {
          if (!selected) return;
          await removeFriend(selected.friend.endpointId);
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
            onDone={() => setEditingIdentity(false)}
            onSave={async (nextProfile) => {
              await account.saveProfile(nextProfile);
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
