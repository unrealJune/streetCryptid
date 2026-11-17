import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CryptidThemes, Spacing, type CryptidChrome } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { PressableAction } from '@/features/social/components/pressable-action';

import type { EnrollFact } from '../core/repeaters';

/**
 * The pieces every full-screen repeater surface shares with the pairing screen it was designed
 * beside: a round back button and a mode label, an island panel along the bottom with a status in
 * tracked mono, and full-width actions. Kept here rather than imported from the pairing screen,
 * whose own copies are private to it and tuned to its stages.
 */

export function useRepeaterChrome(): { chrome: CryptidChrome; dark: boolean } {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return { chrome: CryptidThemes[dark ? 'deepsea' : 'daybreak'].chrome, dark };
}

/** Ink on the accent fill: the pairing screen's, which reads on every theme's green. */
const ON_ACCENT = '#07131f';

/** The console's own picture of a repeater, drawn in the app's mono face. */
export const MACHINE_ART = [
  '    |    ',
  '    |    ',
  ' .--+--. ',
  ' | ( ) | ',
  ' |  *  | ',
  " '-[_]-' ",
].join('\n');

export function MachineArt({ color, small = false }: { color: string; small?: boolean }) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[small ? styles.artSmall : styles.art, { color }]}
    >
      {MACHINE_ART}
    </Text>
  );
}

export function ScreenHeader({
  chrome,
  mode,
  onBack,
  backLabel = 'Back',
  paddingTop,
}: {
  readonly chrome: CryptidChrome;
  readonly mode: string;
  readonly onBack: () => void;
  readonly backLabel?: string;
  readonly paddingTop: number;
}) {
  return (
    <View style={[styles.header, { paddingTop }]}>
      <PressableAction
        accessibilityLabel={backLabel}
        accessibilityRole="button"
        onPress={onBack}
        pressScale={0.9}
        style={[styles.round, { backgroundColor: chrome.seg }]}
      >
        <Text style={[styles.roundGlyph, { color: chrome.ink }]}>{'‹'}</Text>
      </PressableAction>
      <Text accessibilityRole="header" style={[styles.mode, { color: chrome.ink }]}>
        {mode}
      </Text>
      <View style={styles.roundSpacer} />
    </View>
  );
}

export function IslandPanel({
  chrome,
  status,
  statusColor,
  detail,
  onClose,
  marginBottom,
  children,
}: {
  readonly chrome: CryptidChrome;
  readonly status: string;
  readonly statusColor?: string;
  readonly detail?: string | null;
  readonly onClose?: () => void;
  readonly marginBottom: number;
  readonly children?: ReactNode;
}) {
  return (
    <View
      style={[
        styles.panel,
        { backgroundColor: chrome.island, borderColor: chrome.islandBorder, marginBottom },
      ]}
    >
      <View style={styles.statusRow}>
        <View style={styles.statusCopy}>
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.status, { color: statusColor ?? chrome.green }]}
          >
            {status}
          </Text>
          {detail ? <Text style={[styles.detail, { color: chrome.steel }]}>{detail}</Text> : null}
        </View>
        {onClose ? (
          <PressableAction
            accessibilityLabel="Close"
            accessibilityRole="button"
            onPress={onClose}
            pressScale={0.9}
            style={[styles.close, { backgroundColor: chrome.seg }]}
          >
            <Text style={[styles.closeGlyph, { color: chrome.steel }]}>×</Text>
          </PressableAction>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/** One row of the panel's content, inset to the panel's gutter. */
export function PanelRow({ children }: { readonly children: ReactNode }) {
  return <View style={styles.panelRow}>{children}</View>;
}

export function PanelActions({ children }: { readonly children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

export function PanelButton({
  chrome,
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  accessibilityLabel,
  testID,
}: {
  readonly chrome: CryptidChrome;
  readonly label: string;
  readonly onPress: () => void;
  /** `warn` is a destructive action's outline, amber. */
  readonly kind?: 'primary' | 'outline' | 'warn';
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
  readonly testID?: string;
}) {
  const edge = kind === 'warn' ? chrome.amber : kind === 'outline' ? chrome.steel : chrome.green;
  return (
    <PressableAction
      accessibilityLabel={accessibilityLabel ?? label.toLowerCase()}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      haptic="tap"
      onPress={onPress}
      style={[
        styles.button,
        kind === 'primary'
          ? { backgroundColor: chrome.green }
          : { borderColor: edge, borderWidth: StyleSheet.hairlineWidth },
      ]}
      testID={testID}
    >
      <Text style={[styles.buttonLabel, { color: kind === 'primary' ? ON_ACCENT : edge }]}>
        {label}
      </Text>
    </PressableAction>
  );
}

/** A whole row that is one switch: a title, an optional line, and the track. */
export function ToggleRow({
  chrome,
  title,
  text,
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
}: {
  readonly chrome: CryptidChrome;
  readonly title: string;
  readonly text?: string | null;
  readonly value: boolean;
  readonly onChange: (next: boolean) => void;
  readonly disabled?: boolean;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      onPress={() => onChange(!value)}
      style={({ pressed }) => [
        styles.toggle,
        { borderColor: chrome.hairline, opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.toggleCopy}>
        <Text style={[styles.toggleTitle, { color: chrome.ink }]}>{title}</Text>
        {text ? <Text style={[styles.toggleText, { color: chrome.steel }]}>{text}</Text> : null}
      </View>
      <Track chrome={chrome} on={value} />
    </Pressable>
  );
}

export function Track({ chrome, on }: { readonly chrome: CryptidChrome; readonly on: boolean }) {
  return (
    <View
      style={[
        styles.track,
        {
          backgroundColor: on ? chrome.green : chrome.seg,
          justifyContent: on ? 'flex-end' : 'flex-start',
        },
      ]}
    >
      <View style={[styles.knob, { backgroundColor: on ? chrome.panel : chrome.steel }]} />
    </View>
  );
}

export function FactList({
  chrome,
  facts,
}: {
  readonly chrome: CryptidChrome;
  readonly facts: readonly EnrollFact[];
}) {
  return (
    <View style={styles.facts}>
      {facts.map((fact) => (
        <View key={fact.text} style={styles.fact}>
          <Text style={[styles.factMark, { color: fact.good ? chrome.green : chrome.steel }]}>
            {fact.good ? '+' : '·'}
          </Text>
          <Text style={[styles.factText, { color: chrome.ink }]}>{fact.text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  art: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 22,
    lineHeight: 24,
  },
  artSmall: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 15,
    lineHeight: 17,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.three,
    justifyContent: 'space-between',
    paddingBottom: Spacing.two,
    paddingHorizontal: 18,
  },
  round: {
    alignItems: 'center',
    borderRadius: 17,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  roundSpacer: { height: 34, width: 34 },
  roundGlyph: {
    fontFamily: 'Rajdhani_700Bold',
    fontSize: 26,
    lineHeight: 29,
  },
  mode: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.6,
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
  statusCopy: { flex: 1, gap: 3, minWidth: 0 },
  status: {
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
    lineHeight: 15,
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 15,
  },
  close: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    marginRight: -6,
    marginTop: -4,
    width: 30,
  },
  closeGlyph: { fontFamily: 'Rajdhani_700Bold', fontSize: 18, lineHeight: 20 },
  panelRow: {
    gap: 6,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingHorizontal: 18,
    paddingTop: Spacing.three,
  },
  button: {
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
  toggle: {
    alignItems: 'center',
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: Spacing.two,
  },
  toggleCopy: { flex: 1, gap: 2, minWidth: 0 },
  toggleTitle: { fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 12 },
  toggleText: { fontFamily: 'IBMPlexMono_400Regular', fontSize: 10, lineHeight: 14 },
  track: {
    borderRadius: 12,
    flexDirection: 'row',
    height: 24,
    padding: 3,
    width: 40,
  },
  knob: { borderRadius: 9, height: 18, width: 18 },
  facts: { gap: 6 },
  fact: { flexDirection: 'row', gap: Spacing.two },
  factMark: { fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 12, lineHeight: 16, width: 10 },
  factText: { flex: 1, fontFamily: 'IBMPlexMono_400Regular', fontSize: 11, lineHeight: 16 },
});
