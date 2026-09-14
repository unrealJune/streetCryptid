import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  FadeIn,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Spacing } from '@/constants/theme';
import { ThemedText } from '@/components/themed-text';
import { CryptidAvatar } from '@/features/account/components/cryptid-avatar';
import type { Friend } from '@/features/social/core/types';
import {
  PERSONA_PATIENCE_MS,
  PERSONA_SCRIPTED_CHURN_MS,
  hasVerifiedProfile,
  scrambleFrame,
  settleDurationMs,
  settledCount,
} from '@/features/social/core/persona-reveal';

/** ~16fps. Fast enough to read as churn, slow enough that each glyph is legible as a glyph. */
const CHURN_TICK_MS = 62;

interface PersonaRevealProps {
  readonly friend: Friend;
  /** The friend's own signal colour, once their profile has told us what it is. */
  readonly accent: string;
  /** What the ciphertext is drawn in before there is a persona to colour it with. */
  readonly neutral: string;
  /** Fired once, when the handle has finished settling. */
  onResolved?(): void;
}

/**
 * The pairing payoff: an endpoint id decrypting into a person.
 *
 * The churn is driven from JS rather than the UI thread, deliberately. Reanimated cannot change a
 * `Text` node's CONTENT on the UI thread — only its style — so an animated string means either an
 * animated `TextInput` with a worklet-built value, or a short-lived interval. A dozen characters
 * for at most a couple of seconds, on a screen with nothing else to schedule, does not earn the
 * first; the colour and opacity that move underneath it are on the UI thread where they belong.
 */
export function PersonaReveal({ friend, accent, neutral, onResolved }: PersonaRevealProps) {
  const reducedMotion = useReducedMotion();
  const resolved = hasVerifiedProfile(friend);
  const handle = friend.handle;

  /**
   * Whether this persona was ALREADY decrypted the first time it was drawn.
   *
   * Since the v4 pairing wire this is the NORMAL case — the record rides the Accept — so it no
   * longer means "skip the animation", it means "run the scripted one". Captured once, at mount,
   * which is why the caller keys this component by friend: a new pairing gets a new component,
   * and no state here ever has to be reset backwards.
   */
  const [borneResolved] = useState(resolved);
  const instant = reducedMotion;

  const [frame, setFrame] = useState(0);
  const [settleProgress, setSettleProgress] = useState(instant ? 1 : 0);
  const [patienceSpent, setPatienceSpent] = useState(false);
  /** The scripted beat, held only for a persona that needed no waiting for. */
  const [holding, setHolding] = useState(borneResolved && !instant);
  const announced = useRef(instant);

  /**
   * Whether the reveal is allowed to complete.
   *
   * Split from `resolved` so the scripted beat drives the churn, the caption and the colour warm
   * from one place. Without the split the name would appear under a still-scrambling handle.
   */
  const decrypted = resolved && !holding;

  const settling = decrypted && !instant && settleProgress < 1;
  const churning = !decrypted && !instant && !patienceSpent;

  // One interval covers both halves: the churn before the profile lands and the settle after it.
  // They are the same animation — only the target string and whether `settled` advances differ.
  useEffect(() => {
    if (!churning && !settling) return;
    const timer = setInterval(() => setFrame((current) => current + 1), CHURN_TICK_MS);
    return () => clearInterval(timer);
  }, [churning, settling]);

  // Stop churning eventually. This gives up on the ANIMATION, not on the profile: the service
  // keeps retrying for minutes, and a late arrival still gets its settle. A scramble still going
  // after this long has stopped reading as "working" and started reading as broken.
  useEffect(() => {
    if (instant || resolved) return;
    const timer = setTimeout(() => setPatienceSpent(true), PERSONA_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [instant, resolved]);

  // The scripted beat. Runs once, from mount, for a persona that was there when we drew it.
  useEffect(() => {
    if (!holding) return;
    const timer = setTimeout(() => setHolding(false), PERSONA_SCRIPTED_CHURN_MS);
    return () => clearTimeout(timer);
  }, [holding]);

  useEffect(() => {
    if (instant || !decrypted) return;
    const started = Date.now();
    const duration = settleDurationMs(handle);
    const timer = setInterval(() => {
      const elapsed = (Date.now() - started) / duration;
      setSettleProgress(elapsed >= 1 ? 1 : elapsed);
      if (elapsed >= 1) clearInterval(timer);
    }, CHURN_TICK_MS);
    return () => clearInterval(timer);
  }, [decrypted, handle, instant]);

  useEffect(() => {
    if (settleProgress < 1 || announced.current) return;
    announced.current = true;
    onResolved?.();
  }, [onResolved, settleProgress]);

  // Colour and opacity ride the UI thread: the persona's own colour arrives WITH the persona, so
  // the ciphertext is drawn in the neutral it deserves and warms into the friend's signal.
  const warmth = useSharedValue(decrypted ? 1 : 0);
  useEffect(() => {
    warmth.value = withTiming(decrypted ? 1 : 0, {
      duration: instant ? 0 : settleDurationMs(handle),
    });
  }, [decrypted, handle, instant, warmth]);
  const sigilStyle = useAnimatedStyle(() => ({ opacity: 0.22 + warmth.value * 0.78 }));

  const display = instant
    ? handle
    : decrypted
      ? scrambleFrame(handle, settledCount(handle, settleProgress), frame)
      : patienceSpent
        ? handle
        : scrambleFrame(handle, 0, frame);

  // Keyed off `decrypted`, not `resolved`: during the scripted beat the handle is still
  // churning, and a caption that had already gone quiet would leave that looking broken.
  const caption = decrypted ? null : patienceSpent ? 'PERSONA UNAVAILABLE' : 'DECRYPTING PERSONA';

  return (
    <View style={styles.wrap}>
      <ThemedText accessibilityRole="header" style={styles.title}>
        CRYPTID{'\n'}DISCOVERED
      </ThemedText>
      <Animated.View
        layout={reducedMotion ? undefined : LinearTransition.duration(220)}
        style={sigilStyle}
      >
        <CryptidAvatar
          art={friend.sigil}
          color={decrypted ? accent : neutral}
          muted={!decrypted}
          name={friend.cryptidName ?? 'Unknown form'}
          size="large"
          style={styles.avatar}
        />
      </Animated.View>
      <Text
        // The churning value is decoration; a screen reader should hear the friend, or that we are
        // still working on them — never a string of hex that changes sixteen times a second.
        accessibilityLabel={decrypted ? handle : 'Decrypting this cryptid’s persona'}
        allowFontScaling={false}
        style={[
          settleProgress >= 1 ? styles.handle : styles.cipher,
          { color: decrypted ? accent : neutral },
        ]}
      >
        {display}
      </Text>
      {caption ? (
        <Animated.Text
          key={caption}
          entering={reducedMotion ? undefined : FadeIn.duration(260)}
          style={[styles.caption, { color: neutral }]}
        >
          {caption}
        </Animated.Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: Spacing.three,
    width: '100%',
  },
  title: {
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
  /**
   * Monospace while it churns, so a settling character replaces one of the same width and the
   * line does not shuffle under itself. The resolved handle keeps the display face it was
   * designed in — the swap happens once, after the text has stopped moving.
   */
  cipher: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 26,
    letterSpacing: 1,
    lineHeight: 38,
  },
  handle: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    fontWeight: '700',
    lineHeight: 38,
  },
  caption: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    letterSpacing: 1.3,
    textAlign: 'center',
  },
});
