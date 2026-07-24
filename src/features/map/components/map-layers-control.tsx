import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

interface MapLayersControlProps {
  readonly enabled: boolean;
  readonly theme: CryptidTheme;
  onChange(enabled: boolean): void;
}

/** A compact map-layer control that expands in place instead of opening a modal. */
export function MapLayersControl({ enabled, theme, onChange }: MapLayersControlProps) {
  const [expanded, setExpanded] = useState(false);
  const { chrome } = theme;

  return (
    <View pointerEvents="box-none" style={styles.control}>
      {/* Button first so the panel expands DOWNWARD out of it, rather than
          rising over the button it came from. */}
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
          tintColor={enabled ? chrome.amber : chrome.steel}
        />
      </Pressable>

      {expanded ? (
        // The whole row is the checkbox target — the label needs no separate hit
        // area, and one self-evident title replaces the old title + description.
        <Pressable
          accessibilityLabel="Exploration overlay"
          accessibilityRole="checkbox"
          accessibilityState={{ checked: enabled }}
          onPress={() => onChange(!enabled)}
          style={({ pressed }) => [
            styles.panel,
            {
              backgroundColor: chrome.island,
              borderColor: chrome.islandBorder,
              opacity: pressed ? 0.68 : 1,
            },
          ]}
        >
          <Text style={[styles.title, { color: chrome.ink }]}>Exploration Overlay</Text>
          <View
            style={[
              styles.checkbox,
              {
                backgroundColor: enabled ? chrome.amber : 'transparent',
                borderColor: enabled ? chrome.amber : chrome.steel,
              },
            ]}
          >
            {enabled ? (
              <SymbolView
                name={{ ios: 'checkmark', android: 'check', web: 'check' }}
                size={13}
                tintColor={chrome.island}
              />
            ) : null}
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  control: {
    alignItems: 'flex-end',
    gap: Spacing.two,
  },
  panel: {
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
