import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { ThemedText } from '@/components/themed-text';
import { ThemedTextInput } from '@/components/themed-text-input';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { checkClaimLink } from '../core/repeaters';

interface ClaimRepeaterFormProps {
  readonly accent: string;
  readonly warning: string;
  /**
   * Whether this claim starts the roster. Only then is there a policy to choose; a later machine
   * joins the roster as it is.
   */
  readonly firstRepeater: boolean;
  /** Resolves `null` on success, or the words for why it failed. */
  readonly onClaim: (link: string, open: boolean, carryMe: boolean) => Promise<string | null>;
}

/**
 * Claim a machine: paste the link its console printed, choose who may enrol (first machine only),
 * and whether it carries your own trail. The core refuses anything whose signed cert does not
 * name this phone and the machine that answered, so a mistyped or swapped link adds nothing.
 */
export function ClaimRepeaterForm({
  accent,
  warning,
  firstRepeater,
  onClaim,
}: ClaimRepeaterFormProps) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [carryMe, setCarryMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);

  async function paste() {
    const clip = await Clipboard.getStringAsync().catch(() => '');
    if (clip) setText(clip.trim());
  }

  async function claim() {
    const check = checkClaimLink(text);
    if (!check.ok) {
      setStatus({ text: check.reason, failed: true });
      return;
    }
    setBusy(true);
    setStatus({ text: 'Reaching the repeater…', failed: false });
    const failure = await onClaim(check.link, open, carryMe);
    setBusy(false);
    if (failure) {
      setStatus({ text: failure, failed: true });
    } else {
      setText('');
      setStatus({ text: 'Claimed. It is listed in your roster.', failed: false });
    }
  }

  return (
    <View style={[styles.card, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Add a repeater</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Run trail-stash as a repeater (with TRAIL_STASH_DATA_DIR set) on a computer that stays on.
          Until it is claimed it prints a link starting streetcryptid-repeater:, and a fresh one
          every 30 minutes. Paste it here.
        </ThemedText>
      </View>

      <View style={[styles.field, { borderColor: theme.backgroundSelected }]}>
        <ThemedTextInput
          accessibilityLabel="Repeater claim link"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          placeholder="streetcryptid-repeater:…"
          type="code"
          value={text}
          onChangeText={setText}
          style={styles.input}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Paste the claim link"
          disabled={busy}
          onPress={() => void paste()}
          style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
        >
          <ThemedText type="code" style={{ color: accent }}>
            PASTE
          </ThemedText>
        </Pressable>
      </View>

      {firstRepeater ? (
        <View style={styles.option}>
          <View style={styles.copy}>
            <ThemedText type="small">Open to anyone</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {open
                ? 'Anyone who learns of it may ask it to carry their trail.'
                : 'Only people you invite may ask it to carry their trail.'}
            </ThemedText>
          </View>
          <Switch
            accessibilityRole="switch"
            accessibilityLabel="Open to anyone"
            disabled={busy}
            value={open}
            onValueChange={setOpen}
            trackColor={{ true: accent, false: theme.backgroundSelected }}
          />
        </View>
      ) : null}

      <View style={styles.option}>
        <View style={styles.copy}>
          <ThemedText type="small">Carry my trail</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Keep your sealed trail on it, so friends get it while your phone sleeps.
          </ThemedText>
        </View>
        <Switch
          accessibilityRole="switch"
          accessibilityLabel="Carry my trail on the new repeater"
          disabled={busy}
          value={carryMe}
          onValueChange={setCarryMe}
          trackColor={{ true: accent, false: theme.backgroundSelected }}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Claim the repeater"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        onPress={() => void claim()}
        style={({ pressed }) => [styles.action, (pressed || busy) && styles.pressed]}
      >
        <ThemedText type="code" style={{ color: accent }}>
          CLAIM
        </ThemedText>
      </Pressable>

      {status ? (
        <ThemedText
          accessibilityRole={status.failed ? 'alert' : undefined}
          type="code"
          themeColor="textSecondary"
          style={status.failed ? { color: warning } : undefined}
        >
          {status.text}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    flex: 1,
    gap: Spacing.one,
  },
  field: {
    alignItems: 'center',
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  input: {
    flex: 1,
    paddingVertical: Spacing.two,
  },
  option: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
  },
  action: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.58,
  },
});
