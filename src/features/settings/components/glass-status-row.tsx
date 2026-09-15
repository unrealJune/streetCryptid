import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useGlassDiagnosis } from '@/features/map/components/glass-surface';

interface GlassStatusRowProps {
  readonly accent: string;
  readonly warningColor: string;
}

/**
 * Whether this phone is drawing liquid glass, and which check said no.
 *
 * It is here because the failure is invisible from the outside. An iPhone on iOS 25, an iPhone
 * with Reduce Transparency on, and an iPhone running a binary an older Xcode compiled all look
 * exactly the same — the island renders the way it always did — so "it didn't turn on" is a
 * report nobody can act on without opening the device. Four booleans and one sentence turn that
 * into an answer.
 */
export function GlassStatusRow({ accent, warningColor }: GlassStatusRowProps) {
  const glass = useGlassDiagnosis();

  const rows: { label: string; value: string }[] = [
    { label: 'Drawing glass', value: glass.available ? 'Yes' : 'No' },
    { label: 'Platform', value: `${glass.platform} ${glass.osVersion}` },
    { label: 'isLiquidGlassAvailable', value: yesNo(glass.liquidGlass) },
    { label: 'isGlassEffectAPIAvailable', value: yesNo(glass.glassEffectApi) },
    { label: 'Reduce Transparency', value: yesNo(glass.reduceTransparency) },
  ];

  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <ThemedText type="small" themeColor="textSecondary">
            {row.label}
          </ThemedText>
          <ThemedText selectable style={styles.value} type="code">
            {row.value}
          </ThemedText>
        </View>
      ))}
      <ThemedText style={{ color: glass.available ? accent : warningColor }} type="small">
        {glass.reason}
      </ThemedText>
    </View>
  );
}

function yesNo(value: boolean): string {
  return value ? 'true' : 'false';
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.one,
  },
  row: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'space-between',
  },
  value: {
    flex: 1,
    textAlign: 'right',
  },
});
