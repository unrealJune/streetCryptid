import { useEffect, useRef } from 'react';
import { type Href, usePathname, useRouter } from 'expo-router';

import { useLocationSharing } from '@/features/social/hooks/use-location-sharing';

/**
 * Global route coordinator for pairing transitions that can arrive while another
 * screen is visible. The active pairing route owns every visual state.
 */
export function PairingOverlays() {
  const router = useRouter();
  const pathname = usePathname();
  const { pairing } = useLocationSharing();

  const verifications = pairing?.verifications ?? [];
  const leadSessionId = verifications[0]?.sessionId ?? null;
  const discoveredId = pairing?.discoveredFriend
    ? `${pairing.discoveredFriend.endpointId}:${pairing.discoveredFriend.pairedAt ?? 0}`
    : null;
  const transitionId = leadSessionId ?? discoveredId;

  const dismissedForSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (!transitionId || dismissedForSessionId.current === transitionId) return;
    if (pathname === '/pairing') return;
    dismissedForSessionId.current = transitionId;
    router.dismissTo('/pairing' as Href);
  }, [pathname, router, transitionId]);

  return null;
}
