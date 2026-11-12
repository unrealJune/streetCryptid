import * as Clipboard from 'expo-clipboard';
import { type Href, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { type ReactNode, useState } from 'react';
import { StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';
import { successHaptic, warningHaptic } from '@/features/haptics/haptics';
import { PairingSignalField } from '@/features/social/components/pairing-signal-field';
import { PressableAction } from '@/features/social/components/pressable-action';

import {
  IslandPanel,
  MachineArt,
  PanelActions,
  PanelButton,
  PanelRow,
  ScreenHeader,
  ToggleRow,
  useRepeaterChrome,
} from '../components/repeater-chrome';
import { checkClaimLink, claimLinkMachineId, shortId } from '../core/repeaters';
import { useRepeaters } from '../hooks/use-repeaters';

/** Where someone without a repeater yet learns to run one. The claim page itself, by design. */
export const REPEATER_SETUP_URL = 'https://streetcrypt.id/repeater';

export type ClaimStep =
  | { readonly step: 'add'; readonly error: string | null }
  | { readonly step: 'scanned'; readonly link: string }
  | { readonly step: 'reaching'; readonly link: string }
  | {
      readonly step: 'claimed';
      readonly link: string;
      readonly firstRepeater: boolean;
      readonly open: boolean;
      readonly carry: boolean;
    }
  | { readonly step: 'refused'; readonly link: string; readonly reason: string };

/**
 * Settings → Repeaters → Add a repeater (REPEATERS.md §4.1), in the pairing screen's shape: what
 * is happening in the middle, what you can do about it in the island along the bottom.
 *
 * ADD takes the link a repeater's console prints, pasted or typed. There is no camera here on
 * purpose: the console's QR code is an https Universal Link / App Link, so the phone's own camera
 * opens this screen with the link already in it (`+native-intent.tsx` → `?claim=`), which lands
 * on SCANNED. SCANNED names the machine the link points at — read from the link, the same short id
 * the console prints — and asks the two questions a claim settles: whether the roster is open
 * (only for the machine that starts it; later ones join the roster as it is) and whether it
 * carries your own location. REACHING is the claim in flight, bounded at 20 s by the protocol, so
 * there is nothing to cancel. The core refuses any cert that does not name this phone and the
 * machine that answered, which is what CLAIMED means by "cert checked".
 */
export default function ClaimRepeaterScreen() {
  const { chrome } = useRepeaterChrome();
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const router = useRouter();
  const repeaters = useRepeaters();
  const params = useLocalSearchParams<{ claim?: string }>();
  const scanned = typeof params.claim === 'string' ? checkClaimLink(params.claim) : null;
  const [state, setState] = useState<ClaimStep>(() =>
    scanned?.ok
      ? { step: 'scanned', link: scanned.link }
      : { step: 'add', error: scanned && !scanned.ok ? scanned.reason : null }
  );
  // A second scan while the screen is open replaces what the first one filled in.
  const [seenClaim, setSeenClaim] = useState(params.claim);
  if (params.claim !== seenClaim) {
    setSeenClaim(params.claim);
    if (scanned?.ok) setState({ step: 'scanned', link: scanned.link });
  }
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [carry, setCarry] = useState(true);
  // Unknown until the rosters are read; a later machine takes the roster's policy as it is.
  const firstRepeater = repeaters.status === 'ready' && repeaters.sections.mine === null;

  const machine = 'link' in state ? claimLinkMachineId(state.link) : null;
  const machineShort = machine ? shortId(machine) : null;

  function back() {
    if (router.canGoBack()) router.back();
    else router.replace('/settings/repeaters' as Href);
  }

  function takeLink(text: string) {
    const check = checkClaimLink(text);
    if (!check.ok) {
      setState({ step: 'add', error: check.reason });
      return;
    }
    setInput('');
    setState({ step: 'scanned', link: check.link });
  }

  async function pasteLink() {
    const clip = await Clipboard.getStringAsync().catch(() => '');
    if (!clip.trim()) {
      setState({ step: 'add', error: 'Nothing to paste. Copy the link the repeater printed.' });
      return;
    }
    takeLink(clip.trim());
  }

  async function claim(link: string) {
    setState({ step: 'reaching', link });
    const failure = await repeaters.claim(link, firstRepeater && open, carry);
    if (failure) {
      void warningHaptic();
      setState({ step: 'refused', link, reason: failure });
    } else {
      void successHaptic();
      setState({ step: 'claimed', link, firstRepeater, open: firstRepeater && open, carry });
    }
  }

  const fieldSize = Math.min(354, window.width - 36, Math.max(230, window.height * 0.42));
  const unsupported = repeaters.status === 'unsupported';

  let mode = 'ADD A REPEATER';
  let panel: ReactNode;
  let stage: ReactNode;

  switch (state.step) {
    case 'add':
      stage = <MachineArt color={chrome.steel} />;
      panel = (
        <IslandPanel
          chrome={chrome}
          status={unsupported ? 'INSTALLED BUILD REQUIRED' : 'ADD A REPEATER'}
          statusColor={unsupported ? chrome.steel : chrome.ink}
          detail={
            unsupported
              ? 'Repeaters need the installed app, on a build that has them.'
              : (state.error ??
                'Point your phone’s camera at the code on the repeater’s screen, or paste the link it printed.')
          }
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        >
          {unsupported ? null : (
            <>
              <View style={styles.inputRow}>
                <TextInput
                  accessibilityLabel="Repeater claim link"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setInput}
                  onSubmitEditing={() => takeLink(input)}
                  placeholder="Claim link"
                  placeholderTextColor={chrome.steel}
                  selectionColor={chrome.green}
                  style={[
                    styles.input,
                    {
                      borderColor: state.error ? chrome.amber : chrome.hairline,
                      color: chrome.ink,
                    },
                  ]}
                  value={input}
                />
                <PressableAction
                  accessibilityLabel="Use this claim link"
                  accessibilityRole="button"
                  disabled={input.trim().length === 0}
                  onPress={() => takeLink(input)}
                  style={[styles.inlineButton, { borderColor: chrome.green }]}
                >
                  <Text style={[styles.inlineLabel, { color: chrome.green }]}>USE</Text>
                </PressableAction>
              </View>
              <PanelActions>
                <PanelButton
                  chrome={chrome}
                  kind="outline"
                  label="SET UP ↗"
                  accessibilityLabel="How to set up a repeater"
                  onPress={() => void WebBrowser.openBrowserAsync(REPEATER_SETUP_URL)}
                />
                <PanelButton
                  chrome={chrome}
                  label="PASTE LINK"
                  accessibilityLabel="Paste the claim link"
                  onPress={() => void pasteLink()}
                />
              </PanelActions>
            </>
          )}
        </IslandPanel>
      );
      break;

    case 'scanned':
      stage = (
        <View style={styles.centred}>
          <MachineArt color={chrome.steel} />
          {machineShort ? (
            <Text style={[styles.machineId, { color: chrome.ink }]}>{machineShort}</Text>
          ) : null}
        </View>
      );
      panel = (
        <IslandPanel
          chrome={chrome}
          status="SCANNED"
          detail={
            machineShort
              ? `Check that the repeater’s screen says ${machineShort}.`
              : 'Check that this is the link on the repeater in front of you.'
          }
          onClose={() => setState({ step: 'add', error: null })}
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        >
          <PanelRow>
            {firstRepeater ? (
              <ToggleRow
                chrome={chrome}
                title="Open to anyone"
                text={
                  open
                    ? 'Anyone who learns of it may ask it to carry their location.'
                    : 'Only people you invite may ask it to carry their location.'
                }
                value={open}
                onChange={setOpen}
              />
            ) : null}
            <ToggleRow
              chrome={chrome}
              title="Carry my location"
              accessibilityLabel="Carry my location on the new repeater"
              text="Kept sealed on it for friends while your phone sleeps."
              value={carry}
              onChange={setCarry}
            />
          </PanelRow>
          <PanelActions>
            <PanelButton
              chrome={chrome}
              label="CLAIM"
              accessibilityLabel="Claim the repeater"
              onPress={() => void claim(state.link)}
            />
          </PanelActions>
        </IslandPanel>
      );
      break;

    case 'reaching':
    case 'refused': {
      const refused = state.step === 'refused';
      if (refused) mode = 'CLAIM REFUSED';
      stage = (
        <View style={styles.centred}>
          <PairingSignalField
            accent={refused ? chrome.amber : chrome.green}
            base={chrome.dot}
            mode={refused ? 'scatter' : 'inward'}
            size={fieldSize}
          />
          <View pointerEvents="none" style={styles.readout}>
            {machineShort ? (
              <Text style={[styles.readoutText, { color: chrome.ink }]}>{machineShort}</Text>
            ) : null}
            <Text style={[styles.readoutCaption, { color: chrome.steel }]}>
              {refused ? 'CLAIM REFUSED' : 'CHECKING ITS CERT'}
            </Text>
          </View>
        </View>
      );
      panel = (
        <IslandPanel
          chrome={chrome}
          status={refused ? 'NOTHING WAS ADDED' : 'REACHING THE REPEATER'}
          statusColor={refused ? chrome.amber : chrome.green}
          detail={
            refused ? state.reason : 'It has to be running and online. This takes up to 20 seconds.'
          }
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        >
          {refused ? (
            <PanelActions>
              <PanelButton chrome={chrome} kind="outline" label="BACK" onPress={back} />
              <PanelButton
                chrome={chrome}
                label="TRY A NEW LINK"
                onPress={() => setState({ step: 'add', error: null })}
              />
            </PanelActions>
          ) : null}
        </IslandPanel>
      );
      break;
    }

    case 'claimed':
      mode = 'CLAIMED';
      stage = (
        <View style={styles.claimed}>
          <Text style={[styles.kicker, { color: chrome.green }]}>CERT CHECKED</Text>
          <Text style={[styles.headline, { color: chrome.ink }]}>{'REPEATER\nCLAIMED'}</Text>
          <MachineArt color={chrome.steel} small />
          {machineShort ? (
            <Text style={[styles.machineId, { color: chrome.green }]}>{machineShort}</Text>
          ) : null}
        </View>
      );
      panel = (
        <IslandPanel
          chrome={chrome}
          status="CLAIMED"
          detail={[
            state.firstRepeater
              ? state.open
                ? 'Open to anyone'
                : 'Invite only'
              : 'Joined your roster',
            state.carry ? 'carries your location' : 'not carrying you',
          ]
            .filter(Boolean)
            .join(' · ')}
          marginBottom={Math.max(insets.bottom, Spacing.two)}
        >
          <PanelActions>
            <PanelButton
              chrome={chrome}
              kind="outline"
              label="ADD ANOTHER"
              onPress={() => setState({ step: 'add', error: null })}
            />
            <PanelButton
              chrome={chrome}
              label="VIEW ROSTER"
              onPress={() => router.replace('/settings/repeaters/roster' as Href)}
            />
          </PanelActions>
        </IslandPanel>
      );
      break;
  }

  return (
    <View
      style={[
        styles.screen,
        { backgroundColor: chrome.bg, paddingLeft: insets.left, paddingRight: insets.right },
      ]}
    >
      <ScreenHeader
        chrome={chrome}
        mode={mode}
        onBack={back}
        paddingTop={Math.max(insets.top, Spacing.three)}
      />
      <View style={styles.stage}>
        <Animated.View
          key={state.step}
          entering={reducedMotion ? undefined : FadeIn.duration(260)}
          exiting={reducedMotion ? undefined : FadeOut.duration(160)}
          style={styles.centred}
        >
          {stage}
        </Animated.View>
      </View>
      {panel}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  stage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 0,
    paddingHorizontal: 18,
  },
  centred: { alignItems: 'center', gap: 10, justifyContent: 'center' },
  claimed: { alignItems: 'center', gap: 14 },
  machineId: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 34,
    letterSpacing: 3,
    lineHeight: 38,
  },
  kicker: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },
  headline: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 37,
    letterSpacing: 3,
    lineHeight: 42,
    textAlign: 'center',
  },
  readout: { alignItems: 'center', gap: 6, position: 'absolute' },
  readoutText: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 40,
    letterSpacing: 2,
    lineHeight: 44,
  },
  readoutCaption: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.8,
    textAlign: 'center',
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
    paddingHorizontal: 14,
  },
  inlineButton: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 72,
    paddingHorizontal: Spacing.three,
  },
  inlineLabel: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
});
