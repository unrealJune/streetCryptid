import { useColorScheme } from 'react-native';

import { CryptidThemes } from '@/constants/theme';
import { useExplorationBackup } from '@/features/map/hooks/use-exploration-backup';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { AppProvenanceDetails } from '../components/app-provenance';
import { AuthorIdRow } from '../components/author-id-row';
import { ExplorationBackupRow } from '../components/exploration-backup-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

/**
 * What this install is holding and what it is running: the exploration history you
 * can carry to another phone, the author ID your friends' trails are keyed to, and
 * the exact build — which is the first thing anyone asks for when a device stops
 * publishing.
 */
export default function AppDataScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;

  const { snapshot } = useLocationSharing();
  const { busy: backupBusy, exportBackup, restoreBackup } = useExplorationBackup();

  return (
    <SettingsPage title="App & data" subtitle="Your history, your ID, and this build">
      <SettingsSection label="LOCATION HISTORY">
        <ExplorationBackupRow
          accent={chrome.green}
          warningColor={chrome.amber}
          busy={backupBusy}
          onExport={exportBackup}
          onRestore={restoreBackup}
        />
      </SettingsSection>

      <SettingsSection label="APP">
        <AuthorIdRow authorId={snapshot?.self?.endpointId ?? null} />
        <AppProvenanceDetails />
      </SettingsSection>
    </SettingsPage>
  );
}
