import { View } from 'react-native';

import { SettingsMenuRow } from '../components/settings-menu-row';
import { SettingsPage } from '../components/settings-page';

export default function AdvancedScreen() {
  return (
    <SettingsPage title="Advanced">
      <View>
        <SettingsMenuRow href="/settings/transports" label="Transports" />
        <SettingsMenuRow href="/settings/debug" label="Debug" />
      </View>
    </SettingsPage>
  );
}
