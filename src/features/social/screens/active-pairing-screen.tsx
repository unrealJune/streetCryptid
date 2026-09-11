import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import { useArmedBump } from '@/features/social/hooks/use-armed-bump';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { openBluetoothSettings } from '@/features/social/net/bluetooth-settings';

import { PairingSignalField, type PairingFieldMode } from '../components/pairing-signal-field';
import { PairingVerificationPanel } from '../components/pairing-verification-panel';

const INVITE_TTL_SECONDS = 120;
const SHARE_SUBJECT = 'Find me on streetCryptid';

function secondsRemaining(deadline: number | null | undefined, now: number): number {
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isActiveSession(state: string): boolean {
  return !['complete', 'rejected', 'failed'].includes(state);
}

interface PairingPresentation {
  readonly mode: string;
  readonly status: string;
  readonly detail: string;
  readonly caption: string;
  readonly readout: string;
  readonly fieldMode: PairingFieldMode;
  readonly tone: 'signal' | 'steel' | 'amber';
}

export default function ActivePairingScreen() {
  const scheme = useColorScheme();
  const theme = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'];
  const { chrome } = theme;
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const {
    snapshot,
    pairing,
    error: serviceError,
    createPairInvite,
    pairFromInput,
    cancelBump,
    submitPairChoice,
    confirmPairDisplay,
    cancelPair,
    refreshPairing,
    acknowledgeDiscoveredFriend,
    rejectDiscoveredFriend,
  } = useLocationSharing();
  const [redeeming, setRedeeming] = useState(Boolean(token));
  const bump = useArmedBump(!token && !redeeming);
  const [now, setNow] = useState(0);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [working, setWorking] = useState<'link' | 'redeem' | 'retry' | null>(null);
  const redeemedToken = useRef<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void refreshPairing();
      return () => {
        void cancelBump();
      };
    }, [cancelBump, refreshPairing])
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token || !snapshot?.ready || redeemedToken.current === token) return;
    redeemedToken.current = token;
    setRedeeming(true);
    setWorking('redeem');
    void cancelBump()
      .then(() => pairFromInput(token))
      .catch((redeemError: unknown) => {
        setInputError(
          redeemError instanceof Error ? redeemError.message : 'That pairing link could not open.'
        );
      })
      .finally(() => {
        setWorking(null);
        setRedeeming(false);
        router.setParams({ token: undefined });
      });
  }, [cancelBump, pairFromInput, router, snapshot?.ready, token]);

  const verifications = useMemo(() => pairing?.verifications ?? [], [pairing?.verifications]);
  const verification = useMemo(
    () => [...verifications].sort((a, b) => a.deadlineMs - b.deadlineMs)[0] ?? null,
    [verifications]
  );
  const activeSession = pairing?.sessions.find((session) => isActiveSession(session.state)) ?? null;
  const inviteRemaining = now ? secondsRemaining(pairing?.inviteExpiresAt, now) : 0;
  const verificationRemaining = now ? secondsRemaining(verification?.deadlineMs, now) : 0;
  const inviteLive = Boolean(pairing?.inviteLink && inviteRemaining > 0);
  const inviteExpired = Boolean(
    pairing?.inviteLink && pairing?.inviteExpiresAt && !inviteRemaining
  );
  const friend = pairing?.discoveredFriend ?? null;
  const signal = friend ? resolveSignalColor(friend.color, chrome.green) : chrome.green;

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (verification) {
        void cancelPair(verification.sessionId);
        return true;
      }
      router.back();
      return true;
    });
    return () => subscription.remove();
  }, [cancelPair, router, verification]);

  const presentation: PairingPresentation = useMemo(() => {
    if (friend) {
      return {
        mode: 'PAIRED',
        status: '',
        detail: '',
        caption: '',
        readout: '',
        fieldMode: 'pulse',
        tone: 'signal',
      };
    }
    if (verification) {
      return {
        mode: 'VERIFY',
        status: verification.localConfirmed
          ? 'Waiting for the other phone'
          : verification.role === 'picker'
            ? 'Which figure is on their phone?'
            : 'Show them this figure',
        detail: verification.localConfirmed
          ? 'Keep both phones nearby. Pairing completes only after both people confirm.'
          : verification.nearby
            ? 'Compare the screens together before either person confirms.'
            : 'Compare over a trusted voice or video call before confirming.',
        caption: 'VISUAL CHECK',
        readout: formatClock(verificationRemaining),
        fieldMode: 'converge',
        tone: 'signal',
      };
    }
    if (redeeming || working === 'redeem') {
      return {
        mode: 'PAIRING LINK',
        status: inputError ? 'LINK DID NOT OPEN' : 'OPENING A LINK',
        detail:
          inputError ??
          'Reaching the phone that made this link. Keep streetCryptid open on both phones.',
        caption: inputError ? 'TRY ANOTHER LINK' : 'REACHING THEM',
        readout: '',
        fieldMode: inputError ? 'scatter' : 'inward',
        tone: inputError ? 'amber' : 'signal',
      };
    }
    if (activeSession || (pairing?.pendingRequests.length ?? 0) > 0) {
      return {
        mode: 'PAIRING',
        status: 'SIGNAL FOUND',
        detail: 'Starting the encrypted visual check. Keep both phones open.',
        caption: 'EXCHANGING KEYS',
        readout: '',
        fieldMode: 'converge',
        tone: 'signal',
      };
    }
    if (inviteLive) {
      return {
        mode: 'PAIRING LINK',
        status: 'LINK IS LIVE',
        detail: 'Send it to one person. It works once, and only until this timer ends.',
        caption: 'UNTIL THIS LINK EXPIRES',
        readout: formatClock(inviteRemaining),
        fieldMode: 'countdown',
        tone: 'signal',
      };
    }
    if (inviteExpired) {
      return {
        mode: 'LINK EXPIRED',
        status: 'LINK EXPIRED',
        detail: 'That link is no longer valid. Make a new one and send it again.',
        caption: 'EXPIRED',
        readout: '0:00',
        fieldMode: 'scatter',
        tone: 'steel',
      };
    }
    if (!pairing?.available) {
      return {
        mode: 'PAIRING',
        status: 'INSTALLED BUILD REQUIRED',
        detail: 'Nearby pairing uses Bluetooth and is not available in Expo Go or on the web.',
        caption: 'PAIRING UNAVAILABLE',
        readout: '',
        fieldMode: 'scatter',
        tone: 'steel',
      };
    }
    if (pairing.radio === 'poweredOff') {
      return {
        mode: 'BUMP PAUSED',
        status: 'BLUETOOTH IS OFF',
        detail:
          Platform.OS === 'android'
            ? 'Turn Bluetooth on, then return here. Pairing will resume automatically.'
            : 'Turn Bluetooth on in Control Centre or Settings. Pairing will resume automatically.',
        caption: 'RADIO OFF',
        readout: '',
        fieldMode: 'scatter',
        tone: 'amber',
      };
    }
    if (pairing.radio === 'unsupported') {
      return {
        mode: 'LINK PAIRING',
        status: 'NO BLUETOOTH RADIO',
        detail: 'This device cannot use Bump. Make or open a one-time pairing link instead.',
        caption: 'LINKS STILL WORK',
        readout: '',
        fieldMode: 'scatter',
        tone: 'steel',
      };
    }
    if (pairing.bump.stage === 'failed') {
      return {
        mode: 'BUMP MISSED',
        status: 'BUMP MISSED',
        detail: pairing.bump.error ?? 'Keep both phones on this screen and try once more.',
        caption: 'NO CONTACT',
        readout: '',
        fieldMode: 'scatter',
        tone: 'amber',
      };
    }
    if (pairing.bump.stage === 'searching') {
      return {
        mode: 'BUMP ARMED',
        status: `READING ${pairing.bump.peerCount || '—'} SIGNALS`,
        detail: 'Ranking the nearest phone and preparing the encrypted visual check.',
        caption: 'SIGNALS IN RANGE',
        readout: pairing.bump.peerCount ? String(pairing.bump.peerCount) : '',
        fieldMode: 'sweep',
        tone: 'signal',
      };
    }
    if (pairing.bump.stage === 'contact') {
      return {
        mode: 'PAIRING',
        status: 'SIGNAL FOUND',
        detail: 'Starting the encrypted visual check.',
        caption: 'EXCHANGING KEYS',
        readout: '',
        fieldMode: 'converge',
        tone: 'signal',
      };
    }
    if (bump.error || serviceError) {
      return {
        mode: 'BUMP PAUSED',
        status: 'PAIRING NEEDS ATTENTION',
        detail: bump.error ?? serviceError ?? 'Nearby pairing could not start.',
        caption: 'READY TO RETRY',
        readout: '',
        fieldMode: 'scatter',
        tone: 'amber',
      };
    }
    return {
      mode: 'BUMP ARMED',
      status: bump.arming ? 'STARTING NEARBY PAIRING' : 'READY FOR IMPACT',
      detail: bump.arming
        ? 'Opening the Bluetooth listening window.'
        : bump.sensor.status === 'ready'
          ? 'Touch the top edges of both phones together.'
          : 'Touch the phones together, then tap Bump now on both screens.',
      caption: bump.arming ? 'PREPARING' : 'LISTENING',
      readout: '',
      fieldMode: 'pulse',
      tone: 'signal',
    };
  }, [
    activeSession,
    bump.arming,
    bump.error,
    bump.sensor.status,
    friend,
    inputError,
    inviteExpired,
    inviteLive,
    inviteRemaining,
    pairing,
    redeeming,
    serviceError,
    verification,
    verificationRemaining,
    working,
  ]);

  const toneColor =
    presentation.tone === 'signal'
      ? signal
      : presentation.tone === 'amber'
        ? chrome.amber
        : chrome.steel;
  const fieldSize = Math.min(354, width - 36, Math.max(230, height * 0.42));
  const countdownProgress = inviteLive
    ? Math.max(0, Math.min(1, inviteRemaining / INVITE_TTL_SECONDS))
    : 1;

  const createAndShareLink = async (): Promise<void> => {
    if (working) return;
    setWorking('link');
    setInputError(null);
    try {
      const link = await createPairInvite(INVITE_TTL_SECONDS);
      if (!link) throw new Error('A pairing link could not be created.');
      await shareLink(link);
    } catch (linkError: unknown) {
      setInputError(
        linkError instanceof Error ? linkError.message : 'A pairing link could not be created.'
      );
    } finally {
      setWorking(null);
    }
  };

  const shareLink = async (link: string): Promise<void> => {
    await Share.share(
      Platform.OS === 'ios' ? { url: link } : { message: link, title: SHARE_SUBJECT },
      { subject: SHARE_SUBJECT, dialogTitle: SHARE_SUBJECT }
    );
  };

  const submitInput = async (): Promise<void> => {
    const value = input.trim();
    if (!value || working) {
      if (!value) setInputError('Paste a streetCryptid pairing link, token, or code.');
      return;
    }
    setWorking('redeem');
    setRedeeming(true);
    setInputError(null);
    try {
      await cancelBump();
      await pairFromInput(value);
      setInput('');
    } catch (pairError: unknown) {
      setInputError(
        pairError instanceof Error ? pairError.message : 'That pairing link could not open.'
      );
    } finally {
      setRedeeming(false);
      setWorking(null);
    }
  };

  const retryBump = async (): Promise<void> => {
    if (working) return;
    setWorking('retry');
    setInputError(null);
    try {
      await bump.arm();
    } finally {
      setWorking(null);
    }
  };

  const close = (): void => {
    void cancelBump();
    router.back();
  };

  return (
    <View style={[styles.screen, { backgroundColor: chrome.bg }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: Math.max(insets.top, Spacing.three),
          },
        ]}
      >
        <Pressable
          accessibilityLabel="Close pairing"
          accessibilityRole="button"
          onPress={close}
          style={({ pressed }) => [
            styles.back,
            { backgroundColor: chrome.seg, opacity: pressed ? 0.62 : 1 },
          ]}
        >
          <Text style={[styles.backLabel, { color: chrome.ink }]}>{'‹'}</Text>
        </Pressable>
        <View style={styles.mode}>
          <View style={[styles.liveDot, { backgroundColor: toneColor }]} />
          <Text style={[styles.modeLabel, { color: chrome.ink }]}>{presentation.mode}</Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.stage}>
        {friend ? (
          <View style={styles.success}>
            <ThemedText type="code" style={[styles.successKicker, { color: signal }]}>
              FRIEND FOUND
            </ThemedText>
            <ThemedText accessibilityRole="header" style={styles.successTitle}>
              CRYPTID{'\n'}DISCOVERED
            </ThemedText>
            <CryptidAvatar
              art={friend.sigil}
              color={signal}
              name={friend.cryptidName ?? 'Unknown form'}
              size="large"
              style={styles.avatar}
            />
            <ThemedText style={[styles.handle, { color: signal }]}>{friend.handle}</ThemedText>
            <ThemedText type="code" themeColor="textSecondary" style={styles.successCaption}>
              {friend.cryptidName?.toUpperCase() ?? 'UNKNOWN FORM'} · LOCATION SHARING ACTIVE
            </ThemedText>
          </View>
        ) : verification ? (
          <PairingVerificationPanel
            accent={signal}
            embedded
            onCancel={cancelPair}
            onChoose={submitPairChoice}
            onConfirm={confirmPairDisplay}
            verifications={verifications}
          />
        ) : (
          <View style={styles.fieldWrap}>
            <PairingSignalField
              accent={toneColor}
              base={chrome.dot}
              mode={presentation.fieldMode}
              progress={countdownProgress}
              size={fieldSize}
            />
            <View pointerEvents="none" style={styles.readout}>
              {presentation.readout ? (
                <Text style={[styles.readoutText, { color: chrome.ink }]}>
                  {presentation.readout}
                </Text>
              ) : null}
              <Text style={[styles.readoutCaption, { color: chrome.steel }]}>
                {presentation.caption}
              </Text>
            </View>
          </View>
        )}
      </View>

      <View
        style={[
          styles.panel,
          {
            backgroundColor: chrome.island,
            borderColor: chrome.islandBorder,
            marginBottom: Math.max(insets.bottom, Spacing.two),
          },
        ]}
      >
        {!friend ? (
          <View style={styles.statusRow}>
            <View style={styles.statusCopy}>
              <Text
                style={[
                  verification ? styles.statusSentence : styles.statusLabel,
                  { color: verification ? chrome.ink : toneColor },
                ]}
              >
                {presentation.status}
              </Text>
              <Text style={[styles.detail, { color: chrome.steel }]}>{presentation.detail}</Text>
            </View>
            {verification ? (
              <Text style={[styles.smallClock, { color: signal }]}>
                {formatClock(verificationRemaining)}
              </Text>
            ) : null}
          </View>
        ) : null}

        {inviteLive && pairing?.inviteLink ? (
          <View style={styles.linkTools}>
            <Text numberOfLines={2} selectable style={[styles.linkText, { color: chrome.ink }]}>
              {pairing.inviteLink}
            </Text>
            <View style={styles.linkActions}>
              <SmallAction
                color={signal}
                label="COPY"
                onPress={() => void Clipboard.setStringAsync(pairing.inviteLink!)}
              />
              <SmallAction
                color={signal}
                label="SHARE"
                onPress={() => void shareLink(pairing.inviteLink!)}
              />
            </View>
          </View>
        ) : null}

        {!friend && !verification && !activeSession && !inviteLive ? (
          <View style={styles.inputRow}>
            <TextInput
              accessibilityLabel="Pairing link or code"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!working}
              onChangeText={(value) => {
                setInput(value);
                setInputError(null);
              }}
              onSubmitEditing={() => void submitInput()}
              placeholder="Pairing link or code"
              placeholderTextColor={chrome.steel}
              selectionColor={signal}
              style={[
                styles.input,
                {
                  borderColor: inputError ? chrome.amber : chrome.hairline,
                  color: chrome.ink,
                },
              ]}
              value={input}
            />
            <Pressable
              accessibilityLabel="Pair using this link or code"
              accessibilityRole="button"
              disabled={Boolean(working)}
              onPress={() => void submitInput()}
              style={({ pressed }) => [
                styles.pairButton,
                {
                  borderColor: signal,
                  opacity: working ? 0.4 : pressed ? 0.62 : 1,
                },
              ]}
            >
              <Text style={[styles.buttonLabel, { color: signal }]}>PAIR</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={styles.actions}>
          {friend ? (
            <>
              <Action
                color={chrome.steel}
                label="REJECT"
                onPress={() => void rejectDiscoveredFriend().then(close)}
                outline
              />
              <Action
                color={signal}
                label="ACKNOWLEDGE"
                onPress={() => {
                  acknowledgeDiscoveredFriend();
                  close();
                }}
              />
            </>
          ) : verification ? (
            <Action
              color={chrome.steel}
              label="STOP PAIRING"
              onPress={() => void cancelPair(verification.sessionId)}
              outline
            />
          ) : pairing?.radio === 'poweredOff' && Platform.OS === 'android' ? (
            <Action
              color={signal}
              label="TURN ON BLUETOOTH"
              onPress={() => void openBluetoothSettings()}
            />
          ) : pairing?.bump.stage === 'failed' || bump.error || serviceError ? (
            <>
              <Action
                color={chrome.steel}
                label="MAKE A LINK"
                onPress={() => void createAndShareLink()}
                outline
              />
              <Action color={signal} label="TRY AGAIN" onPress={() => void retryBump()} />
            </>
          ) : pairing?.bump.stage === 'armed' && bump.sensor.status !== 'ready' ? (
            <>
              <Action
                color={chrome.steel}
                label="MAKE A LINK"
                onPress={() => void createAndShareLink()}
                outline
              />
              <Action color={signal} label="BUMP NOW" onPress={() => void bump.commit()} />
            </>
          ) : inviteExpired ? (
            <>
              <Action
                color={chrome.steel}
                label="BACK TO BUMP"
                onPress={() => void retryBump()}
                outline
              />
              <Action color={signal} label="NEW LINK" onPress={() => void createAndShareLink()} />
            </>
          ) : !inviteLive && !activeSession ? (
            <Action color={signal} label="MAKE A LINK" onPress={() => void createAndShareLink()} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SmallAction({ color, label, onPress }: { color: string; label: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityLabel={label === 'COPY' ? 'Copy pairing link' : 'Share pairing link'}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.smallAction,
        { borderColor: color, opacity: pressed ? 0.62 : 1 },
      ]}
    >
      <Text style={[styles.smallActionLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Action({
  color,
  label,
  onPress,
  outline = false,
}: {
  color: string;
  label: string;
  onPress(): void;
  outline?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label.toLowerCase()}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: outline ? 'transparent' : color,
          borderColor: color,
          borderWidth: outline ? StyleSheet.hairlineWidth : 0,
          opacity: pressed ? 0.68 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonLabel, { color: outline ? color : '#07131f' }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: Spacing.two,
    paddingHorizontal: 18,
  },
  back: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  backLabel: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 28,
    lineHeight: 31,
  },
  mode: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.two,
  },
  liveDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  modeLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.6,
  },
  headerSpacer: {
    width: 34,
  },
  stage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 0,
    paddingHorizontal: 18,
  },
  fieldWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  readout: {
    alignItems: 'center',
    gap: 6,
    position: 'absolute',
  },
  readoutText: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 46,
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
    lineHeight: 50,
  },
  readoutCaption: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.8,
    textAlign: 'center',
  },
  panel: {
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
    paddingBottom: Spacing.three,
  },
  statusRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.three,
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  statusCopy: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  statusLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  statusSentence: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 13,
    lineHeight: 18,
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  smallClock: {
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 10,
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
  },
  linkTools: {
    gap: Spacing.two,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  linkText: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 16,
  },
  linkActions: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  smallAction: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: 12,
  },
  smallActionLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  inputRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  input: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  pairButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: Spacing.three,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  action: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: Spacing.two,
  },
  buttonLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
    textAlign: 'center',
  },
  success: {
    alignItems: 'center',
    gap: Spacing.three,
    width: '100%',
  },
  successKicker: {
    fontWeight: '700',
    letterSpacing: 2,
  },
  successTitle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 37,
    fontWeight: '700',
    letterSpacing: 3,
    lineHeight: 42,
    textAlign: 'center',
  },
  avatar: {
    minHeight: 170,
    minWidth: 220,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 38,
  },
  successCaption: {
    letterSpacing: 1.3,
    textAlign: 'center',
  },
});
