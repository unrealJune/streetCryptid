import { ColorThemeRow } from '../components/color-theme-row';
import { MapColorSchemeRow } from '../components/map-color-scheme-row';
import { DistanceUnitsRow } from '../components/distance-units-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * How the app looks: which theme it wears, which palette it is drawn in, and what distances are
 * counted in.
 *
 * The colour theme is no longer only the map's. Chrome is derived from the selected palette
 * (`features/map/theme/derive-chrome.ts`), so each preset previews the island and a FAB over its
 * canvas as well — picking Kyoto moves Settings too, and a preview that showed only the map would
 * be describing half of what the tap does.
 *
 * Every preset previews light and dark side by side, because the theme above it can be `System` —
 * in which case you will see both without choosing either.
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
