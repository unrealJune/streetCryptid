import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedTextInput } from '@/components/themed-text-input';
import { Fonts, Spacing } from '@/constants/theme';
import { rgbToHex } from '@/features/map/core/color';
import { useMapColorScheme } from '@/features/map/hooks/use-map-color-scheme';
import { useTheme } from '@/hooks/use-theme';

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
                  backgroundColor: selected ? theme.backgroundSelected : 'transparent',
                  borderColor: selected ? theme.textSecondary : theme.backgroundSelected,
                  opacity: pressed ? 0.58 : 1,
                },
              ]}
            >
              <View style={styles.swatches}>
                <View style={[styles.swatch, { backgroundColor: rgbToHex(scheme.light.bg) }]} />
                <View style={[styles.swatch, { backgroundColor: rgbToHex(scheme.light.accent) }]} />
                <View style={[styles.swatch, { backgroundColor: rgbToHex(scheme.dark.bg) }]} />
                <View style={[styles.swatch, { backgroundColor: rgbToHex(scheme.dark.accent) }]} />
              </View>
              <ThemedText type="code">{scheme.name.toUpperCase()}</ThemedText>
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
    gap: Spacing.two,
  },
  option: {
    alignItems: 'center',
    borderRadius: Spacing.one,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 48,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  swatches: {
    borderRadius: 999,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  swatch: {
    height: 24,
    width: 16,
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
