import { Group, RoundedRect, Text as SkiaText, type SkFont } from '@shopify/react-native-skia';

interface LocatorLabelProps {
  label: string;
  color: string;
  panelColor: string;
  font: SkFont | null;
}

/** Compact map-attached label shared by YOU and friend locators. */
export function LocatorLabel({ label, color, panelColor, font }: LocatorLabelProps) {
  if (!font) return null;
  const width = Math.ceil(font.measureText(label).width) + 12;

  return (
    <Group>
      <RoundedRect x={10} y={-12} width={width} height={20} r={4} color={panelColor} />
      <SkiaText x={16} y={3} text={label} color={color} font={font} />
    </Group>
  );
}
