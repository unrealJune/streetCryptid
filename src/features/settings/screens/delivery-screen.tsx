import { useMemo, useState } from 'react';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ThemedText } from '@/components/themed-text';
import { CryptidThemes } from '@/constants/theme';
import type { DeliveryAvailability, DeliveryMode } from '@/features/social/core/delivery-mode';
import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

import { DeliveryOptions } from '../components/delivery-options';
import { LocationAccessRow } from '../components/location-access-row';
import { SettingsPage, SettingsSection } from '../components/settings-page';

export default function DeliveryScreen() {
  const scheme = useColorScheme();
  const chrome = CryptidThemes[scheme === 'dark' ? 'deepsea' : 'daybreak'].chrome;
  const { snapshot, setDeliveryMode, disclosureStatus, acknowledgeLocationDisclosure } =
    useLocationSharing();
  const availability = useMemo<DeliveryAvailability>(
    () => ({ stashConfigured: snapshot?.delivery.stashConfigured ?? false }),
    [snapshot?.delivery.stashConfigured]
  );
  const [pending, setPending] = useState<DeliveryMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = pending ?? snapshot?.delivery.mode ?? 'mutual';

  async function select(mode: DeliveryMode) {
    setPending(mode);
    setError(null);
    try {
      await setDeliveryMode(mode);
    } catch {
      setError('Could not save the delivery mode. Try again.');
    } finally {
      setPending(null);
    }
  }

  return (
    <SettingsPage title="Delivery">
      <DeliveryOptions
        selected={selected}
        availability={availability}
        disabled={pending !== null}
        onSelect={(mode) => void select(mode)}
      />
      {error ? (
        <ThemedText accessibilityRole="alert" type="small">
          {error}
        </ThemedText>
      ) : null}
      <SettingsSection label="ACCESS">
        <LocationAccessRow
          accent={chrome.amber}
          status={disclosureStatus}
          onTurnOn={() => void acknowledgeLocationDisclosure(true)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
