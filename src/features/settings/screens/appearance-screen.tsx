import { MapColorSchemeRow } from '../components/map-color-scheme-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * The map's color scheme. Every preset previews light and dark side by side,
 * because the app follows the OS and you will see both.
 */
export default function AppearanceScreen() {
  return (
    <SettingsPage title="Appearance" subtitle="How the map is colored">
      <SettingsSection label="MAP COLOR SCHEME">
        <MapColorSchemeRow />
      </SettingsSection>
    </SettingsPage>
  );
}
