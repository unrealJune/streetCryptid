import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

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
      {expanded ? (
        <View
          style={[
            styles.panel,
            {
              backgroundColor: chrome.island,
              borderColor: chrome.islandBorder,
            },
          ]}
        >
          <View style={styles.copy}>
            <Text style={[styles.title, { color: chrome.ink }]}>Exploration</Text>
            <Text style={[styles.detail, { color: chrome.steel }]}>
              Explored / unexplored overlay
            </Text>
          </View>
          <Switch
            accessibilityLabel="Explored and unexplored overlay"
            ios_backgroundColor={chrome.seg}
            onValueChange={onChange}
            thumbColor={enabled ? chrome.panel : chrome.steel}
            trackColor={{ false: chrome.seg, true: chrome.amber }}
            value={enabled}
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
          tintColor={enabled ? chrome.amber : chrome.steel}
        />
      </Pressable>
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
    minHeight: 64,
    paddingHorizontal: Spacing.three,
    width: 250,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontFamily: 'Rajdhani_600SemiBold',
    fontSize: 17,
    fontWeight: '600',
  },
  detail: {
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 10,
    lineHeight: 14,
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
