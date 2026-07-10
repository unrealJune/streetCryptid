import { Circle, Group, type SkFont } from '@shopify/react-native-skia';

import { LocatorLabel } from './locator-label';

interface FriendLocatorProps {
  x: number;
  y: number;
  handle: string;
  color: string;
  panelColor: string;
  font: SkFont | null;
  stale?: boolean;
}

/** Contact-green friend presence, intentionally quieter than the amber YOU pin. */
export function FriendLocator({
  x,
  y,
  handle,
  color,
  panelColor,
  font,
  stale = false,
}: FriendLocatorProps) {
  return (
    <Group opacity={stale ? 0.52 : 1} transform={[{ translateX: x }, { translateY: y }]}>
      <Circle r={15} color={color} opacity={0.28} style="stroke" strokeWidth={1.2} />
      <Circle r={8} color={color} opacity={0.5} style="stroke" strokeWidth={1.2} />
      <Circle r={4.5} color={color} />
      <Circle r={1.7} color={panelColor} />
      <LocatorLabel label={handle} color={color} panelColor={panelColor} font={font} />
    </Group>
  );
}
