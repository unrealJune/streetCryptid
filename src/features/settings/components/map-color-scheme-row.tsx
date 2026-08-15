import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedTextInput } from '@/components/themed-text-input';
import { Fonts, Spacing } from '@/constants/theme';
import { ramp, rgbToHex } from '@/features/map/core/color';
import type { MapPalette } from '@/features/map/core/types';
import { useMapColorScheme } from '@/features/map/hooks/use-map-color-scheme';
import type { MapColorScheme } from '@/features/map/theme/map-color-schemes';
import { useTheme } from '@/hooks/use-theme';

function MiniMap({ palette }: { palette: MapPalette }) {
  const road = rgbToHex(ramp(palette.terr, 0.58));
  const arterial = rgbToHex(ramp(palette.terr, 0.82));
  const highway = rgbToHex(ramp(palette.terr, 0.98));

  return (
    <View style={[styles.miniMap, { backgroundColor: rgbToHex(palette.bg) }]}>
      <View style={[styles.water, { backgroundColor: rgbToHex(ramp(palette.water, 0.68)) }]} />
      <View
        style={[
          styles.park,
          styles.parkOne,
          { backgroundColor: rgbToHex(ramp(palette.park, 0.68)) },
        ]}
      />
      <View
        style={[
          styles.park,
          styles.parkTwo,
          { backgroundColor: rgbToHex(ramp(palette.park, 0.82)) },
        ]}
      />
      <View style={[styles.road, styles.roadOne, { backgroundColor: road }]} />
      <View style={[styles.road, styles.roadTwo, { backgroundColor: road }]} />
      <View style={[styles.road, styles.roadThree, { backgroundColor: arterial }]} />
      <View style={[styles.road, styles.roadFour, { backgroundColor: arterial }]} />
      <View style={[styles.highway, { backgroundColor: highway }]} />
      <View style={[styles.transit, { backgroundColor: rgbToHex(palette.transit) }]} />
      <View style={[styles.accent, { backgroundColor: rgbToHex(palette.accent) }]} />
    </View>
  );
}

function SchemePreview({ scheme }: { scheme: MapColorScheme }) {
  return (
    <View style={styles.preview} testID={`${scheme.id}-map-preview`}>
      <MiniMap palette={scheme.light} />
      <MiniMap palette={scheme.dark} />
      <View pointerEvents="none" style={styles.previewDivider} />
      <View pointerEvents="none" style={styles.modeLabels}>
        <ThemedText style={styles.modeLabel} type="code">
          L
        </ThemedText>
        <ThemedText style={styles.modeLabel} type="code">
          D
        </ThemedText>
      </View>
    </View>
  );
}

export function MapColorSchemeRow() {
  const theme = useTheme();
  const { customJson, saveCustom, schemes, select, selectedId } = useMapColorScheme();
  const [editorOpen, setEditorOpen] = useState(false);
  const [json, setJson] = useState(customJson);
  const [error, setError] = useState<string | null>(null);

  const applyCustom = async () => {
    try {
      await saveCustom(json);
      setError(null);
      setEditorOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the custom palette');
    }
  };

  return (
    <View style={[styles.container, { borderColor: theme.backgroundSelected }]}>
      <View style={styles.copy}>
        <ThemedText type="smallBold">Map colors</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          Each scheme includes a light and dark palette and follows your device appearance.
        </ThemedText>
      </View>

      <View accessibilityRole="radiogroup" style={styles.options}>
        {schemes.map((scheme) => {
          const selected = scheme.id === selectedId;
          return (
            <Pressable
              accessibilityLabel={`${scheme.name} map colors`}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              key={scheme.id}
              onPress={() => void select(scheme.id)}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: selected ? theme.backgroundElement : 'transparent',
                  borderColor: selected ? theme.text : theme.backgroundSelected,
                  opacity: pressed ? 0.58 : 1,
                },
              ]}
            >
              <SchemePreview scheme={scheme} />
              <View style={styles.optionLabel}>
                <ThemedText numberOfLines={1} type="code">
                  {scheme.name.toUpperCase()}
                </ThemedText>
                <View
                  style={[
                    styles.selectionDot,
                    {
                      backgroundColor: selected ? theme.text : 'transparent',
                      borderColor: selected ? theme.text : theme.textSecondary,
                    },
                  ]}
                />
              </View>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        accessibilityLabel={editorOpen ? 'Cancel custom map palette' : 'Import custom map palette'}
        accessibilityRole="button"
        onPress={() => {
          if (!editorOpen) setJson(customJson);
          setEditorOpen(!editorOpen);
          setError(null);
        }}
        style={({ pressed }) => [
          styles.customButton,
          { borderColor: theme.backgroundSelected, opacity: pressed ? 0.58 : 1 },
        ]}
      >
        <ThemedText type="code">{editorOpen ? 'CANCEL CUSTOM' : 'IMPORT CUSTOM'}</ThemedText>
      </Pressable>

      {editorOpen ? (
        <View style={styles.editor}>
          <ThemedText type="small" themeColor="textSecondary">
            Edit the JSON below. Every color uses #RRGGBB; ramps accept 2 to 7 colors.
          </ThemedText>
          <ThemedTextInput
            accessibilityLabel="Custom map palette JSON"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            onChangeText={setJson}
            spellCheck={false}
            style={[
              styles.input,
              {
                backgroundColor: theme.backgroundElement,
                borderColor: error ? '#C2413B' : theme.backgroundSelected,
              },
            ]}
            type="code"
            value={json}
          />
          {error ? (
            <ThemedText accessibilityRole="alert" style={styles.error} type="small">
              {error}
            </ThemedText>
          ) : null}
          <Pressable
            accessibilityLabel="Apply custom map palette"
            accessibilityRole="button"
            onPress={() => void applyCustom()}
            style={({ pressed }) => [
              styles.apply,
              { backgroundColor: theme.text, opacity: pressed ? 0.68 : 1 },
            ]}
          >
            <ThemedText style={{ color: theme.background }} type="code">
              APPLY CUSTOM PALETTE
            </ThemedText>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.three,
    padding: Spacing.three,
  },
  copy: {
    gap: Spacing.one,
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  option: {
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    flexBasis: '47%',
    flexGrow: 1,
    gap: Spacing.two,
    minWidth: 132,
    overflow: 'hidden',
    padding: Spacing.two,
  },
  preview: {
    borderRadius: Spacing.one,
    flexDirection: 'row',
    height: 94,
    overflow: 'hidden',
    position: 'relative',
  },
  previewDivider: {
    backgroundColor: 'rgba(255,255,255,.4)',
    bottom: 0,
    left: '50%',
    position: 'absolute',
    top: 0,
    width: StyleSheet.hairlineWidth,
  },
  modeLabels: {
    bottom: 4,
    flexDirection: 'row',
    justifyContent: 'space-around',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  modeLabel: {
    backgroundColor: 'rgba(5,10,18,.62)',
    borderRadius: 5,
    color: '#FFFFFF',
    fontSize: 8,
    lineHeight: 11,
    overflow: 'hidden',
    paddingHorizontal: 3,
  },
  miniMap: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  water: {
    borderRadius: 28,
    bottom: -15,
    position: 'absolute',
    right: -15,
    top: -10,
    transform: [{ rotate: '16deg' }],
    width: '35%',
  },
  park: {
    borderRadius: 999,
    position: 'absolute',
  },
  parkOne: {
    height: 28,
    left: 7,
    top: 10,
    transform: [{ rotate: '-18deg' }],
    width: 38,
  },
  parkTwo: {
    bottom: 11,
    height: 20,
    right: 15,
    transform: [{ rotate: '12deg' }],
    width: 29,
  },
  road: {
    height: 2,
    left: -10,
    position: 'absolute',
    width: '130%',
  },
  roadOne: {
    top: 25,
    transform: [{ rotate: '28deg' }],
  },
  roadTwo: {
    top: 55,
    transform: [{ rotate: '-20deg' }],
  },
  roadThree: {
    height: 3,
    top: 42,
    transform: [{ rotate: '4deg' }],
  },
  roadFour: {
    height: 3,
    top: 68,
    transform: [{ rotate: '38deg' }],
  },
  highway: {
    height: 5,
    left: -12,
    position: 'absolute',
    top: 16,
    transform: [{ rotate: '64deg' }],
    width: '140%',
  },
  transit: {
    height: 2,
    left: -8,
    position: 'absolute',
    top: 74,
    transform: [{ rotate: '-6deg' }],
    width: '125%',
  },
  accent: {
    borderRadius: 5,
    height: 7,
    left: '46%',
    position: 'absolute',
    top: '46%',
    width: 7,
  },
  optionLabel: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
    justifyContent: 'space-between',
    minHeight: 20,
  },
  selectionDot: {
    borderRadius: 6,
    borderWidth: 1,
    height: 10,
    width: 10,
  },
  customButton: {
    alignItems: 'center',
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.two,
  },
  editor: {
    gap: Spacing.two,
  },
  input: {
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    fontFamily: Fonts.mono,
    fontSize: 12,
    minHeight: 320,
    padding: Spacing.three,
    textAlignVertical: 'top',
  },
  error: {
    color: '#C2413B',
  },
  apply: {
    alignItems: 'center',
    borderRadius: Spacing.one,
    padding: Spacing.three,
  },
});
