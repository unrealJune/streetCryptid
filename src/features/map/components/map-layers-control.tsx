import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

interface MapLayersControlProps {
  readonly enabled: boolean;
  readonly transitEnabled: boolean;
  readonly theme: CryptidTheme;
  onChange(enabled: boolean): void;
  onTransitChange(enabled: boolean): void;
}

/** A compact map-layer control that expands in place instead of opening a modal. */
export function MapLayersControl({
  enabled,
  transitEnabled,
  theme,
  onChange,
  onTransitChange,
}: MapLayersControlProps) {
  const [expanded, setExpanded] = useState(false);
  const { chrome } = theme;
  const anyLayer = enabled || transitEnabled;

  return (
    <View pointerEvents="box-none" style={styles.control}>
      {/* Panel first so it expands UPWARD out of the button. The control sits at
          the bottom of the screen, so downward has nowhere to go — it would open
          off-screen behind the island. */}
      {expanded ? (
        <View style={styles.panel}>
          <LayerToggle checked={enabled} label="Exploration" onChange={onChange} theme={theme} />
          <LayerToggle
            checked={transitEnabled}
            label="Transit"
            onChange={onTransitChange}
            theme={theme}
          />
        </View>
      ) : null}

      <Pressable
        accessibilityLabel="Map layers"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: chrome.island,
            borderColor: expanded ? chrome.amber : chrome.islandBorder,
            opacity: pressed ? 0.68 : 1,
          },
        ]}
      >
        <SymbolView
          name={{ ios: 'square.3.layers.3d', android: 'layers', web: 'layers' }}
          size={21}
          tintColor={anyLayer ? chrome.amber : chrome.steel}
        />
      </Pressable>
    </View>
  );
}

/**
 * One layer row. The whole row is the checkbox target — the label needs no
 * separate hit area, and one self-evident title replaces a title + description.
 */
function LayerToggle({
  checked,
  label,
  onChange,
  theme,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly theme: CryptidTheme;
  onChange(enabled: boolean): void;
}) {
  const { chrome } = theme;
  return (
    <Pressable
      accessibilityLabel={`${label} overlay`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: chrome.island,
          borderColor: chrome.islandBorder,
          opacity: pressed ? 0.68 : 1,
        },
      ]}
    >
      <Text style={[styles.title, { color: chrome.ink }]}>{label}</Text>
      <View
        style={[
          styles.checkbox,
          {
            backgroundColor: checked ? chrome.amber : 'transparent',
            borderColor: checked ? chrome.amber : chrome.steel,
          },
        ]}
      >
        {checked ? (
          <SymbolView
            name={{ ios: 'checkmark', android: 'check', web: 'check' }}
            size={13}
            tintColor={chrome.island}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  control: {
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  panel: {
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  row: {
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
  },
  title: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 20,
  },
  checkbox: {
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: 1.5,
    height: 20,
    justifyContent: 'center',
    width: 20,
  },
  fab: {
    alignItems: 'center',
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
});
