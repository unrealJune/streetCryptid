import { GlassContainer } from 'expo-glass-effect';
import { SymbolView } from 'expo-symbols';
import { StyleSheet, Text, View } from 'react-native';

import type { CryptidTheme } from '@/constants/cryptid-theme';
import { Spacing } from '@/constants/theme';

import { formatColor, parseColor } from '../theme/derive-chrome';
import { FAB_RADIUS, IslandPressable, islandStyles, useGlassAvailable } from './glass-surface';

/** The map layers this control switches. */
export interface MapLayerToggles {
  /** The explored/unexplored fog treatment. */
  readonly exploration: boolean;
  /** Motorways — the widest strokes in the dot field. */
  readonly highways: boolean;
  /** Rail / tram / subway / ferry lines drawn over the dot field. */
  readonly transit: boolean;
  /** Building footprints and airport surfaces drawn over the dot field. */
  readonly structures: boolean;
}

export type MapLayerId = keyof MapLayerToggles;

interface MapLayersControlProps {
  readonly layers: MapLayerToggles;
  readonly theme: CryptidTheme;
  /**
   * Whether the panel is open. Owned by the screen rather than by this control: the panel is a
   * popover over the map, and a popover has to close when the user's attention moves on — which
   * only the screen can see, because the taps that move it (the map, the drawer, a roster row)
   * land on components this one knows nothing about.
   */
  readonly expanded: boolean;
  onChange(layer: MapLayerId, enabled: boolean): void;
  onExpandedChange(expanded: boolean): void;
}

const LAYERS: { readonly id: MapLayerId; readonly title: string }[] = [
  { id: 'exploration', title: 'Exploration' },
  { id: 'highways', title: 'Highways' },
  { id: 'transit', title: 'Transit' },
  { id: 'structures', title: 'Buildings' },
];

const ROW_RADIUS = 12;

/**
 * How far apart two glass surfaces still pull on each other. At this distance the rows and the
 * button read as drops of the same liquid rather than as a stack of separate panels — which is
 * the one thing the material does that a translucent rectangle cannot.
 */
const GLASS_MERGE_SPACING = 24;

/** A tint strong enough to say "lit" and weak enough to still be a window. */
const LIT_TINT_ALPHA = 0.22;

function tint(color: string, alpha: number): string | undefined {
  const parsed = parseColor(color);
  return parsed ? formatColor(parsed.rgb, alpha) : undefined;
}

/** A compact map-layer control that expands in place instead of opening a modal. */
export function MapLayersControl({
  layers,
  theme,
  expanded,
  onChange,
  onExpandedChange,
}: MapLayersControlProps) {
  const { chrome } = theme;
  const glass = useGlassAvailable();
  // The FAB reads lit while anything the panel can switch off is still on.
  const anyEnabled = LAYERS.some((layer) => layers[layer.id]);

  return (
    // One container, so that opening the panel is the button growing rather than four panels
    // appearing next to it. Off iOS 26 this is a plain View and the layout is unchanged.
    <GlassContainer pointerEvents="box-none" spacing={GLASS_MERGE_SPACING} style={styles.control}>
      {/* Panel first so it expands UPWARD out of the button. The control sits at
          the bottom of the screen, so downward has nowhere to go — it would open
          off-screen behind the island. */}
      {expanded ? (
        <View style={styles.panel}>
          {LAYERS.map((layer) => (
            <LayerToggle
              checked={layers[layer.id]}
              key={layer.id}
              label={layer.title}
              onChange={(enabled) => onChange(layer.id, enabled)}
              theme={theme}
            />
          ))}
        </View>
      ) : null}

      <IslandPressable
        accessibilityLabel="Map layers"
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        // Open is said with the border off glass and with the material's own tint on it: an amber
        // hairline around a pane of amber-tinted glass is one statement made twice.
        borderColor={expanded && !glass ? chrome.amber : undefined}
        onPress={() => onExpandedChange(!expanded)}
        radius={FAB_RADIUS}
        style={islandStyles.fab}
        theme={theme}
        tintColor={expanded ? tint(chrome.amber, LIT_TINT_ALPHA) : undefined}
      >
        <SymbolView
          name={{ ios: 'square.3.layers.3d', android: 'layers', web: 'layers' }}
          size={21}
          tintColor={anyEnabled ? chrome.amber : chrome.steel}
        />
      </IslandPressable>
    </GlassContainer>
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
    <IslandPressable
      accessibilityLabel={`${label} layer`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onChange(!checked)}
      radius={ROW_RADIUS}
      style={styles.row}
      theme={theme}
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
    </IslandPressable>
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
});
