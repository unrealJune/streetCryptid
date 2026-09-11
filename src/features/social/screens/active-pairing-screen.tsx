import * as Clipboard from 'expo-clipboard';
import type { PairStateValue } from 'iroh-location';
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  BackHandler,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { resolveSignalColor } from '@/constants/signal-colors';
import { CryptidThemes, Spacing } from '@/constants/theme';
import {
  describePairingFailure,
  deriveActivePairingStage,
  inviteScreenState,
  type ActivePairingStage,
  type PairingRouteIntent,
} from '@/features/social/core/active-pairing-state';
import { patternHaptic, successHaptic, tapHaptic, warningHaptic } from '@/features/haptics/haptics';
import { PERSONA_RESOLVE } from '@/features/social/core/pairing-experience';
import { useArmedBump } from '@/features/social/hooks/use-armed-bump';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';
import { usePairingHaptics } from '@/features/social/hooks/use-pairing-haptics';
import { usePairingVerification } from '@/features/social/hooks/use-pairing-verification';
import { openBluetoothSettings } from '@/features/social/net/bluetooth-settings';
import { TERMINAL_PAIR_STATES } from '@/features/social/net/location-sharing';

import { PairingFigureChoices, PairingFigureView } from '../components/pairing-figure-view';
import { PersonaReveal } from '../components/persona-reveal';
import { PairingQr } from '../components/pairing-qr';
import { PairingSignalField, type PairingFieldMode } from '../components/pairing-signal-field';
import { PressableAction } from '../components/pressable-action';

const INVITE_TTL_SECONDS = 120;
const SHARE_SUBJECT = 'Find me on streetCryptid';
const QR_SIZE = 88;
/** Content swaps are quick enough not to feel like a page load, slow enough to read as a move. */
const SWAP_IN_MS = 260;
const SWAP_OUT_MS = 160;

function secondsRemaining(deadline: number | null | undefined, now: number): number {
  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function isActiveSession(state: PairStateValue): boolean {
  return !TERMINAL_PAIR_STATES.includes(state);
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
  const reducedMotion = useReducedMotion();
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(params.token) ? params.token[0] : params.token;
  const {
    snapshot,
    pairing,
    createPairInvite,
    pairFromInput,
    cancelBump,
    cancelPairInvite,
    clearPairingFailure,
    submitPairChoice,
    confirmPairDisplay,
    cancelPair,
    refreshPairing,
    acknowledgeDiscoveredFriend,
    rejectDiscoveredFriend,
  } = useLocationSharing();
  const [intent, setIntent] = useState<PairingRouteIntent>(token ? 'redeem' : 'bump');
  const [redeeming, setRedeeming] = useState(Boolean(token));
  const [now, setNow] = useState(0);
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [dismissedLink, setDismissedLink] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<'link' | 'redeem' | 'retry' | null>(null);
  const redeemedToken = useRef<string | null>(null);
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setForeground(next === 'active')
    );
    return () => subscription.remove();
  }, []);

  /**
   * Sessions this phone would be walking out on, kept in a ref.
   *
   * The focus cleanup must not depend on them — it would tear down and re-run on every poll — but
   * it does have to know them at the moment it fires, which is exactly what a ref is for.
   */
  const abandonableRef = useRef<readonly string[]>([]);

  /**
   * Leave the pairing, and TELL THE OTHER PHONE.
   *
   * Closing the radio was never enough. A half-finished session that is merely walked away from
   * stays alive on the peer until its SAS window times out, so the phone that shared a link sat
   * there watching a handshake that had already been abandoned — and, before the invite was
   * tracked, went right back to offering the spent link. Cancelling is what turns "they left" into
   * something the other side learns immediately.
   */
  const standDown = useCallback(async (): Promise<void> => {
    const sessionIds = abandonableRef.current;
    abandonableRef.current = [];
    await Promise.allSettled([
      cancelBump(),
      ...sessionIds.map((sessionId) => cancelPair(sessionId)),
    ]);
  }, [cancelBump, cancelPair]);

  useFocusEffect(
    useCallback(() => {
      void refreshPairing();
      return () => {
        void standDown();
      };
    }, [refreshPairing, standDown])
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!token || !snapshot?.ready || redeemedToken.current === token) return;
    redeemedToken.current = token;
    setIntent('redeem');
    setRedeeming(true);
    setWorking('redeem');
    void cancelBump()
      .then(() => pairFromInput(token))
      .then(() => setIntent('bump'))
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
  useEffect(() => {
    const sessionIds = new Set<string>();
    for (const entry of verifications) sessionIds.add(entry.sessionId);
    for (const request of pairing?.pendingRequests ?? []) sessionIds.add(request.sessionId);
    for (const session of pairing?.sessions ?? []) {
      if (isActiveSession(session.state)) sessionIds.add(session.sessionId);
    }
    abandonableRef.current = [...sessionIds];
  }, [pairing?.pendingRequests, pairing?.sessions, verifications]);

  const verifyHandlers = useMemo(
    () => ({ onChoose: submitPairChoice, onConfirm: confirmPairDisplay, onCancel: cancelPair }),
    [cancelPair, confirmPairDisplay, submitPairChoice]
  );
  const verify = usePairingVerification(verifications, verifyHandlers);
  const verification = verify.verification;
  const activeSession = pairing?.sessions.find((session) => isActiveSession(session.state)) ?? null;
  const inviteRemaining = now ? secondsRemaining(pairing?.inviteExpiresAt, now) : 0;
  const invite = inviteScreenState({
    inviteLink: pairing?.inviteLink,
    remainingSeconds: inviteRemaining,
    redeemed: pairing?.inviteRedeemed ?? false,
    dismissedLink,
  });
  const inviteLive = invite === 'live';
  const inviteSpent = invite === 'spent';
  const inviteExpired = invite === 'expired' && Boolean(pairing?.inviteExpiresAt);
  const failure = pairing?.failure ?? null;
  const effectiveIntent: PairingRouteIntent =
    !token && intent === 'bump' && inviteLive ? 'link' : intent;
  const bump = useArmedBump(effectiveIntent === 'bump' && !token && !redeeming);
  // Every pairing channel, not just Bump — this hook used to hang off `useArmedBump`, which is
  // armed for nearby pairing only, so a link or QR pair had no haptics of any kind. Gated on
  // focus AND foreground, not merely on being mounted: this screen survives backgrounding, and a
  // pulse loop beating away in someone's pocket is worse than no haptics at all.
  usePairingHaptics(pairing, focused && foreground);
  const personaResolved = useCallback(() => {
    void patternHaptic(PERSONA_RESOLVE);
  }, []);
  const friend = pairing?.discoveredFriend ?? null;
  const signal = friend ? resolveSignalColor(friend.color, chrome.green) : chrome.green;

  const stage: ActivePairingStage = deriveActivePairingStage({
    intent: effectiveIntent,
    pairingLoaded: pairing !== null,
    available: pairing?.available ?? false,
    radio: pairing?.radio ?? 'unknown',
    bumpStage: pairing?.bump.stage ?? 'idle',
    bumpArming: bump.arming,
    bumpError: bump.error,
    hasFriend: Boolean(friend),
    hasVerification: Boolean(verification),
    hasActiveSession: Boolean(activeSession || (pairing?.pendingRequests.length ?? 0) > 0),
    redeeming: redeeming || working === 'redeem',
    creatingLink: working === 'link',
    inputError,
    inviteLive,
    inviteSpent,
    inviteExpired,
    failure,
  });

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (scanning) {
        setScanning(false);
        return true;
      }
      if (verification) {
        verify.cancel();
        return true;
      }
      router.back();
      return true;
    });
    return () => subscription.remove();
  }, [router, scanning, verification, verify]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  // A link going dead is the one moment here that happens WITHOUT anyone touching the phone, so
  // it is the one that most needs to be felt: the user may well be looking at the other device.
  // Failure and discovery have their own patterns in `usePairingHaptics`; this covers the link.
  const lastDeadLinkStage = useRef<ActivePairingStage | null>(null);
  useEffect(() => {
    const dead = stage === 'link-expired' || stage === 'link-spent';
    if (!dead) {
      lastDeadLinkStage.current = null;
      return;
    }
    if (lastDeadLinkStage.current === stage) return;
    lastDeadLinkStage.current = stage;
    void warningHaptic();
  }, [stage]);

  const presentation: PairingPresentation = useMemo(() => {
    switch (stage) {
      case 'discovered':
        return {
          mode: 'PAIRED',
          status: '',
          detail: '',
          caption: '',
          readout: '',
          fieldMode: 'pulse',
          tone: 'signal',
        };
      case 'verifying':
        return {
          mode: 'VERIFY',
          status: verify.status,
          detail: verify.detail,
          caption: 'VISUAL CHECK',
          readout: verify.clock,
          fieldMode: verify.mode === 'invalid' ? 'scatter' : 'converge',
          tone: verify.mode === 'invalid' ? 'amber' : 'signal',
        };
      case 'pair-failed': {
        const copy = failure
          ? describePairingFailure(failure)
          : { status: 'PAIRING STOPPED', detail: 'Nothing was shared.' };
        return {
          mode: failure?.nearby ? 'BUMP FAILED' : 'PAIRING FAILED',
          status: copy.status,
          detail: copy.detail,
          caption: 'NOTHING SHARED',
          readout: '',
          fieldMode: 'fracture',
          tone: 'amber',
        };
      }
      case 'link-spent':
        return {
          mode: 'LINK USED',
          status: 'THIS LINK HAS BEEN USED',
          detail:
            'Someone already opened it, so it will not work again. Make a new one if you still need to pair.',
          caption: 'SPENT',
          readout: '',
          fieldMode: 'scatter',
          tone: 'steel',
        };
      case 'redeeming':
        return {
          mode: 'PAIRING LINK',
          status: 'OPENING A LINK',
          detail: 'Reaching the phone that made this link. Keep streetCryptid open on both phones.',
          caption: 'REACHING THEM',
          readout: '',
          fieldMode: 'inward',
          tone: 'signal',
        };
      case 'redeem-failed':
        return {
          mode: 'PAIRING LINK',
          status: 'LINK DID NOT OPEN',
          detail: inputError ?? 'That pairing link could not open.',
          caption: 'TRY ANOTHER LINK',
          readout: '',
          fieldMode: 'scatter',
          tone: 'amber',
        };
      case 'handshaking':
      case 'bump-contact':
        return {
          mode: 'PAIRING',
          status: 'SIGNAL FOUND',
          detail: 'Starting the encrypted visual check. Keep both phones open.',
          caption: 'EXCHANGING KEYS',
          readout: '',
          fieldMode: 'converge',
          tone: 'signal',
        };
      case 'link-creating':
        return {
          mode: 'PAIRING LINK',
          status: 'MAKING A LINK',
          detail: 'Sealing a one-time invitation on this phone.',
          caption: 'PREPARING LINK',
          readout: '',
          fieldMode: 'inward',
          tone: 'signal',
        };
      case 'link-live':
        return {
          mode: 'PAIRING LINK',
          status: 'LINK IS LIVE',
          detail: 'Send it to one person. It works once, and only until this timer ends.',
          caption: 'UNTIL THIS LINK EXPIRES',
          readout: formatClock(inviteRemaining),
          fieldMode: 'countdown',
          tone: 'signal',
        };
      case 'link-expired':
        return {
          mode: 'LINK EXPIRED',
          status: 'LINK EXPIRED',
          detail: 'That link is no longer valid. Make a new one and send it again.',
          caption: 'EXPIRED',
          readout: '0:00',
          fieldMode: 'scatter',
          tone: 'steel',
        };
      case 'link-failed':
        return {
          mode: 'PAIRING LINK',
          status: 'LINK COULD NOT BE MADE',
          detail: inputError ?? 'A pairing link could not be created.',
          caption: 'READY TO RETRY',
          readout: '',
          fieldMode: 'scatter',
          tone: 'amber',
        };
      case 'loading':
        return {
          mode: 'BUMP',
          status: 'PREPARING PAIRING',
          detail: 'Waking the encrypted nearby service.',
          caption: 'PREPARING',
          readout: '',
          fieldMode: 'pulse',
          tone: 'signal',
        };
      case 'unavailable':
        return {
          mode: 'PAIRING',
          status: 'INSTALLED BUILD REQUIRED',
          detail: 'Nearby pairing uses Bluetooth and is not available in Expo Go or on the web.',
          caption: 'PAIRING UNAVAILABLE',
          readout: '',
          fieldMode: 'scatter',
          tone: 'steel',
        };
      case 'radio-off':
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
      case 'radio-unsupported':
        return {
          mode: 'LINK PAIRING',
          status: 'NO BLUETOOTH RADIO',
          detail: 'This device cannot use Bump. Make or open a one-time pairing link instead.',
          caption: 'LINKS STILL WORK',
          readout: '',
          fieldMode: 'scatter',
          tone: 'steel',
        };
      case 'bump-failed':
        return {
          mode: 'BUMP MISSED',
          status: 'BUMP MISSED',
          detail: pairing?.bump.error ?? bump.error ?? 'Keep both phones here and try once more.',
          caption: 'NO CONTACT',
          readout: '',
          fieldMode: 'scatter',
          tone: 'amber',
        };
      case 'bump-searching':
        return {
          mode: 'BUMP ARMED',
          status: `READING ${pairing?.bump.peerCount || '—'} SIGNALS`,
          detail: 'Ranking the nearest phone and preparing the encrypted visual check.',
          caption: 'SIGNALS IN RANGE',
          readout: pairing?.bump.peerCount ? String(pairing.bump.peerCount) : '',
          fieldMode: 'sweep',
          tone: 'signal',
        };
      case 'bump-starting':
        return {
          mode: 'BUMP ARMED',
          status: 'STARTING NEARBY PAIRING',
          detail: 'Opening the Bluetooth listening window.',
          caption: 'PREPARING',
          readout: '',
          fieldMode: 'pulse',
          tone: 'signal',
        };
      case 'bump-armed':
        return {
          mode: 'BUMP ARMED',
          status: 'READY FOR IMPACT',
          detail:
            bump.sensor.status === 'ready'
              ? 'Touch the top edges of both phones together.'
              : 'Touch the phones together, then tap Bump now on both screens.',
          caption: 'LISTENING',
          readout: '',
          fieldMode: 'pulse',
          tone: 'signal',
        };
    }
  }, [
    bump.error,
    bump.sensor.status,
    failure,
    inputError,
    inviteRemaining,
    pairing,
    stage,
    verify.clock,
    verify.detail,
    verify.mode,
    verify.status,
  ]);

  const toneColor =
    presentation.tone === 'signal'
      ? signal
      : presentation.tone === 'amber'
        ? chrome.amber
        : chrome.steel;
  const fieldSize = Math.min(354, width - 36, Math.max(230, height * 0.42));
  // A QR symbol must be dark-on-light whatever the theme: plenty of scanners refuse an inverted
  // one, and a code the other phone cannot read is worse than a swatch slightly off-palette.
  // Both pairs below are drawn from the theme's own extremes, so it still belongs to the screen.
  const dark = scheme === 'dark';
  const qrField = dark ? chrome.ink : chrome.panel;
  const qrModule = dark ? chrome.void : chrome.ink;
  const scanSize = Math.min(width - 72, height * 0.46, 340);
  // The enlarged code must not outlive the link it encodes, so it is derived from the live link
  // rather than latched: the moment the stage stops being `link-live`, there is nothing to show.
  const scanLink = scanning && stage === 'link-live' ? (pairing?.inviteLink ?? null) : null;
  const countdownProgress =
    stage === 'link-live' ? Math.max(0, Math.min(1, inviteRemaining / INVITE_TTL_SECONDS)) : 1;

  // The mode dot breathes while the radio is genuinely doing something, and holds still once
  // the screen is waiting on a person rather than on hardware.
  const dotPulse = useSharedValue(0);
  const liveModes = stage === 'bump-armed' || stage === 'bump-searching' || stage === 'link-live';
  useEffect(() => {
    if (!liveModes || reducedMotion) {
      dotPulse.value = withTiming(0, { duration: 200 });
      return;
    }
    dotPulse.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: 900, easing: Easing.inOut(Easing.quad) })
      ),
      -1,
      false
    );
  }, [dotPulse, liveModes, reducedMotion]);
  const dotStyle = useAnimatedStyle(() => ({
    opacity: 1 - dotPulse.value * 0.55,
    transform: [{ scale: 1 + dotPulse.value * 0.35 }],
  }));

  const createAndShareLink = async (): Promise<void> => {
    if (working) return;
    setIntent('link');
    setWorking('link');
    setInputError(null);
    setScanning(false);
    setDismissedLink(null);
    setLinkNotice(null);
    clearPairingFailure();
    try {
      await cancelBump();
      const link = await createPairInvite(INVITE_TTL_SECONDS);
      if (!link) throw new Error('A pairing link could not be created.');
      void successHaptic();
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
    setIntent('redeem');
    setRedeeming(true);
    setInputError(null);
    try {
      await cancelBump();
      await pairFromInput(value);
      setIntent('bump');
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
    setIntent('bump');
    setWorking('retry');
    setInputError(null);
    clearPairingFailure();
    try {
      await bump.arm();
    } finally {
      setWorking(null);
    }
  };

  const returnToBump = (): void => {
    setInputError(null);
    setLinkNotice(null);
    clearPairingFailure();
    setIntent('bump');
  };

  /**
   * Cancel the link, then go back to Bump.
   *
   * Dismissing locally is not optional even when revocation succeeds: a live invite outranks the
   * Bump intent, so without recording that this link is finished with, `setIntent('bump')` is
   * undone by the next render and the button does nothing at all. Revocation is what makes the
   * token stop working; the dismissal is what makes the screen move.
   */
  const cancelLinkAndReturn = async (): Promise<void> => {
    if (working) return;
    const link = pairing?.inviteLink ?? null;
    setWorking('link');
    try {
      const outcome = await cancelPairInvite();
      setDismissedLink(link);
      // Only an older binary warrants a warning. A `cancelled` link is genuinely dead, and an
      // `absent` one was never there — neither is something to interrupt anyone about.
      setLinkNotice(
        outcome === 'unsupported'
          ? 'This build cannot withdraw a link. It stops working when its timer runs out.'
          : null
      );
      // Not `returnToBump()` — that clears the notice this branch just set.
      setInputError(null);
      setIntent('bump');
    } finally {
      setWorking(null);
    }
  };

  const close = (): void => {
    void standDown();
    router.back();
  };

  const showPasteRow =
    !friend &&
    !verification &&
    !activeSession &&
    !['link-live', 'link-creating', 'redeeming', 'pair-failed'].includes(stage);

  // One key per distinct thing the stage can show. Changing it crossfades the stage; leaving it
  // alone (a countdown tick, a rising peer count) lets the existing content update in place.
  const stageKey = friend
    ? 'discovered'
    : verification
      ? `verify:${verify.mode}`
      : `field:${presentation.fieldMode}`;

  return (
    <View style={[styles.screen, { backgroundColor: chrome.bg }]}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top, Spacing.three) }]}>
        <PressableAction
          accessibilityLabel="Close pairing"
          accessibilityRole="button"
          onPress={close}
          pressScale={0.9}
          style={[styles.back, { backgroundColor: chrome.seg }]}
        >
          <Text style={[styles.backLabel, { color: chrome.ink }]}>{'‹'}</Text>
        </PressableAction>
        <View style={styles.mode}>
          <Animated.View style={[styles.liveDot, { backgroundColor: toneColor }, dotStyle]} />
          <Animated.Text
            key={presentation.mode}
            entering={reducedMotion ? undefined : FadeIn.duration(SWAP_IN_MS)}
            style={[styles.modeLabel, { color: chrome.ink }]}
          >
            {presentation.mode}
          </Animated.Text>
        </View>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.stage}>
        <Animated.View
          key={stageKey}
          entering={reducedMotion ? undefined : FadeIn.duration(SWAP_IN_MS)}
          exiting={reducedMotion ? undefined : FadeOut.duration(SWAP_OUT_MS)}
          style={styles.stageContent}
        >
          {friend ? (
            <PersonaReveal
              // Keyed by friend so a second pairing gets a fresh reveal rather than a component
              // trying to unwind the last one's state.
              key={friend.endpointId}
              accent={signal}
              friend={friend}
              neutral={chrome.steel}
              onResolved={personaResolved}
            />
          ) : verify.mode === 'pick' ? (
            <PairingFigureChoices
              accent={signal}
              borderColor={chrome.hairline}
              disabled={verify.disabled}
              onChoose={verify.choose}
              options={verify.options}
            />
          ) : verify.target && (verify.mode === 'show' || verify.mode === 'waiting') ? (
            <PairingFigureView accent={signal} figure={verify.target} large />
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
        </Animated.View>
      </View>

      <Animated.View
        layout={reducedMotion ? undefined : LinearTransition.duration(SWAP_IN_MS)}
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
            <Animated.View
              key={presentation.status}
              entering={reducedMotion ? undefined : FadeIn.duration(SWAP_IN_MS)}
              style={styles.statusCopy}
            >
              <Text
                style={[
                  verification ? styles.statusSentence : styles.statusLabel,
                  { color: verification ? chrome.ink : toneColor },
                ]}
              >
                {presentation.status}
              </Text>
              <Text style={[styles.detail, { color: chrome.steel }]}>{presentation.detail}</Text>
              {linkNotice ? (
                <Text style={[styles.detail, { color: chrome.amber }]}>{linkNotice}</Text>
              ) : null}
            </Animated.View>
            {verification ? (
              <Text
                accessibilityLabel={
                  verify.expired
                    ? 'This verification has expired'
                    : `Verification time remaining ${verify.clock}`
                }
                style={[styles.smallClock, { color: verify.expired ? chrome.amber : chrome.steel }]}
              >
                {verify.clock}
              </Text>
            ) : null}
          </View>
        ) : null}

        {stage === 'link-live' && pairing?.inviteLink ? (
          <Animated.View
            entering={reducedMotion ? undefined : FadeIn.duration(SWAP_IN_MS)}
            style={styles.linkTools}
          >
            <PressableAction
              accessibilityHint="Opens the code large enough for another phone to scan"
              accessibilityLabel="Show the pairing QR code large enough to scan"
              accessibilityRole="button"
              onPress={() => setScanning(true)}
            >
              <PairingQr
                background={qrField}
                color={qrModule}
                size={QR_SIZE}
                value={pairing.inviteLink}
              />
            </PressableAction>
            <View style={styles.linkCopy}>
              <Text numberOfLines={2} selectable style={[styles.linkText, { color: chrome.ink }]}>
                {pairing.inviteLink}
              </Text>
              <View style={styles.linkActions}>
                <SmallAction
                  color={signal}
                  label={copied ? 'COPIED' : 'COPY'}
                  onPress={() => {
                    void Clipboard.setStringAsync(pairing.inviteLink!);
                    void tapHaptic();
                    setCopied(true);
                  }}
                />
                <SmallAction
                  color={signal}
                  label="SHARE"
                  onPress={() => void shareLink(pairing.inviteLink!)}
                />
                <SmallAction color={signal} label="QR" onPress={() => setScanning(true)} />
              </View>
            </View>
          </Animated.View>
        ) : null}

        {showPasteRow ? (
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
                { borderColor: inputError ? chrome.amber : chrome.hairline, color: chrome.ink },
              ]}
              value={input}
            />
            <PressableAction
              accessibilityLabel="Pair using this link or code"
              accessibilityRole="button"
              disabled={Boolean(working)}
              onPress={() => void submitInput()}
              style={[styles.pairButton, { borderColor: signal }]}
            >
              <Text style={[styles.buttonLabel, { color: signal }]}>PAIR</Text>
            </PressableAction>
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
          ) : verify.mode === 'show' ? (
            <>
              <Action
                accessibilityLabel="The other person picked a different figure"
                color={chrome.steel}
                disabled={verify.disabled}
                hapticOnPress={false}
                label="DIFFERENT"
                onPress={() => verify.confirm(false)}
                outline
                testID="pairing-confirm-different"
              />
              <Action
                accessibilityLabel="The other person picked this figure"
                color={signal}
                disabled={verify.disabled}
                hapticOnPress={false}
                label="THEY MATCHED"
                onPress={() => verify.confirm(true)}
                testID="pairing-confirm-matched"
              />
            </>
          ) : verify.mode ? (
            <Action
              accessibilityLabel={
                verify.mode === 'invalid' ? 'Stop invalid pairing attempt' : 'stop pairing'
              }
              color={chrome.steel}
              hapticOnPress={false}
              label="STOP PAIRING"
              onPress={verify.cancel}
              outline
            />
          ) : stage === 'radio-off' && Platform.OS === 'android' ? (
            <Action
              color={signal}
              label="TURN ON BLUETOOTH"
              onPress={() => void openBluetoothSettings()}
            />
          ) : stage === 'link-live' ? (
            <Action
              color={chrome.steel}
              disabled={Boolean(working)}
              label="CANCEL LINK"
              onPress={() => void cancelLinkAndReturn()}
              outline
            />
          ) : stage === 'pair-failed' ? (
            <>
              <Action color={chrome.steel} label="NOT NOW" onPress={returnToBump} outline />
              {failure?.nearby ? (
                <Action color={signal} label="TRY AGAIN" onPress={() => void retryBump()} />
              ) : (
                <Action color={signal} label="NEW LINK" onPress={() => void createAndShareLink()} />
              )}
            </>
          ) : stage === 'link-spent' ? (
            <>
              <Action color={chrome.steel} label="BACK TO BUMP" onPress={returnToBump} outline />
              <Action color={signal} label="NEW LINK" onPress={() => void createAndShareLink()} />
            </>
          ) : stage === 'bump-failed' ? (
            <>
              <Action
                color={chrome.steel}
                label="MAKE A LINK"
                onPress={() => void createAndShareLink()}
                outline
              />
              <Action color={signal} label="TRY AGAIN" onPress={() => void retryBump()} />
            </>
          ) : stage === 'bump-armed' && bump.sensor.status !== 'ready' ? (
            <>
              <Action
                color={chrome.steel}
                label="MAKE A LINK"
                onPress={() => void createAndShareLink()}
                outline
              />
              <Action color={signal} label="BUMP NOW" onPress={() => void bump.commit()} />
            </>
          ) : stage === 'link-expired' || stage === 'link-failed' || stage === 'redeem-failed' ? (
            <>
              <Action color={chrome.steel} label="BACK TO BUMP" onPress={returnToBump} outline />
              <Action color={signal} label="NEW LINK" onPress={() => void createAndShareLink()} />
            </>
          ) : stage === 'bump-armed' ||
            stage === 'bump-starting' ||
            stage === 'unavailable' ||
            stage === 'radio-unsupported' ? (
            <Action color={signal} label="MAKE A LINK" onPress={() => void createAndShareLink()} />
          ) : null}
        </View>

        {verify.queued > 0 ? (
          <ThemedText type="code" themeColor="textSecondary" style={styles.queue}>
            {verify.queued} MORE SIGNAL{verify.queued === 1 ? '' : 'S'} WAITING
          </ThemedText>
        ) : null}
      </Animated.View>

      {scanLink ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(SWAP_IN_MS)}
          exiting={reducedMotion ? undefined : FadeOut.duration(SWAP_OUT_MS)}
          style={[styles.scanOverlay, { backgroundColor: chrome.scrim }]}
        >
          <PressableAction
            accessibilityLabel="Hide the pairing QR code"
            accessibilityRole="button"
            onPress={() => setScanning(false)}
            pressScale={1}
            style={styles.scanDismiss}
          >
            <View />
          </PressableAction>
          <View
            style={[
              styles.scanCard,
              { backgroundColor: chrome.panel, borderColor: chrome.islandBorder },
            ]}
          >
            <PairingQr background={qrField} color={qrModule} size={scanSize} value={scanLink} />
            <Text style={[styles.scanCaption, { color: chrome.steel }]}>
              POINT THE OTHER PHONE&apos;S CAMERA AT THIS
            </Text>
            <Text style={[styles.scanClock, { color: signal }]}>
              {formatClock(inviteRemaining)} LEFT
            </Text>
            <View style={styles.scanActions}>
              <Action color={signal} label="DONE" onPress={() => setScanning(false)} />
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

function SmallAction({ color, label, onPress }: { color: string; label: string; onPress(): void }) {
  return (
    <PressableAction
      accessibilityLabel={
        label.startsWith('COP')
          ? 'Copy pairing link'
          : label === 'QR'
            ? 'Show the pairing QR code large enough to scan'
            : 'Share pairing link'
      }
      accessibilityRole="button"
      haptic="selection"
      onPress={onPress}
      style={[styles.smallAction, { borderColor: color }]}
    >
      <Animated.Text
        key={label}
        entering={FadeIn.duration(160)}
        style={[styles.smallActionLabel, { color }]}
      >
        {label}
      </Animated.Text>
    </PressableAction>
  );
}

function Action({
  accessibilityLabel,
  color,
  disabled = false,
  hapticOnPress = true,
  label,
  onPress,
  outline = false,
  testID,
}: {
  accessibilityLabel?: string;
  color: string;
  disabled?: boolean;
  hapticOnPress?: boolean;
  label: string;
  onPress(): void;
  outline?: boolean;
  testID?: string;
}) {
  return (
    <PressableAction
      accessibilityLabel={accessibilityLabel ?? label.toLowerCase()}
      accessibilityRole="button"
      disabled={disabled}
      // The SAS buttons deliberately do NOT opt in: `usePairingVerification` already gives each
      // of those four acts its own distinct feel, and a press tick on top would blunt them.
      haptic={hapticOnPress ? 'tap' : undefined}
      onPress={onPress}
      style={[
        styles.action,
        {
          backgroundColor: outline ? 'transparent' : color,
          borderColor: color,
          borderWidth: outline ? StyleSheet.hairlineWidth : 0,
        },
      ]}
      testID={testID}
    >
      <Text style={[styles.buttonLabel, { color: outline ? color : '#07131f' }]}>{label}</Text>
    </PressableAction>
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
  stageContent: {
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: 520,
    width: '100%',
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
    paddingTop: 1,
  },
  linkTools: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  linkCopy: {
    flex: 1,
    gap: Spacing.two,
    minWidth: 0,
  },
  linkText: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  linkActions: {
    flexDirection: 'row',
    gap: 6,
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
  queue: {
    paddingTop: Spacing.two,
    textAlign: 'center',
  },
  scanOverlay: {
    alignItems: 'center',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
    justifyContent: 'center',
    padding: Spacing.four,
  },
  scanActions: {
    alignSelf: 'stretch',
    flexDirection: 'row',
  },
  scanDismiss: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  scanCard: {
    alignItems: 'center',
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.four,
  },
  scanCaption: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.8,
    textAlign: 'center',
  },
  scanClock: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 28,
    fontVariant: ['tabular-nums'],
    letterSpacing: 2,
    lineHeight: 30,
  },
});
