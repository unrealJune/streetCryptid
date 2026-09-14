import { ColorThemeRow } from '../components/color-theme-row';
import { MapColorSchemeRow } from '../components/map-color-scheme-row';
import { DistanceUnitsRow } from '../components/distance-units-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * How the app looks: which theme it wears, which palette the map draws in, and what distances
 * are counted in.
 *
 * Every map preset previews light and dark side by side, because the theme above it can be
 * `System` — in which case you will see both without choosing either.
 */
export default function AppearanceScreen() {
  return (
    <SettingsPage title="Appearance">
      <SettingsSection label="LIGHT & DARK">
        <ColorThemeRow />
      </SettingsSection>
      <SettingsSection label="COLOR THEME">
        <MapColorSchemeRow />
      </SettingsSection>
      <SettingsSection label="DISTANCE UNITS">
        <DistanceUnitsRow />
      </SettingsSection>
    </SettingsPage>
  );
}
