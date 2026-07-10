import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { AppState } from 'react-native';

import { useCryptidProfile } from '@/features/account/hooks/use-cryptid-profile';
import { buildFriendPresence, type FriendPresence } from '@/features/social/core/presence';
import type { IncomingFix, LocationFix } from '@/features/social/core/types';
import { SELF_AUTHOR, type TrailPoint } from '@/features/social/net/background/trail-store';
import {
  LocationSharingService,
  type PairingSnapshot,
  type SharingSnapshot,
} from '@/features/social/net/location-sharing';
import {
  ensureLocalNetworkPermission,
  ensurePairingPermissions,
} from '@/features/social/net/pairing-permissions';

export type LocationRuntimeStatus =
  'starting' | 'running' | 'permission-denied' | 'unavailable' | 'error';

interface LocationSharingContextValue {
  snapshot: SharingSnapshot | null;
  pairing: PairingSnapshot | null;
  trail: TrailPoint[];
  selfFix: LocationFix | null;
  hasLiveSelfFix: boolean;
  friends: FriendPresence[];
  locationStatus: LocationRuntimeStatus;
  error: string | null;
  setPairingReady(ready: boolean): Promise<void>;
  beginNearbyGesture(): Promise<void>;
  createPairInvite(ttlSecs?: number): Promise<string | undefined>;
  pairFromInput(input: string): Promise<void>;
  respondPair(sessionId: string, accept: boolean): Promise<void>;
  refreshPairing(): Promise<void>;
  toggleShare(endpointId: string, on: boolean): Promise<void>;
  retryLocation(): Promise<void>;
  clearPairingCelebration(): void;
}

const LocationSharingContext = createContext<LocationSharingContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function locationStatusFor(error: unknown): LocationRuntimeStatus {
  return /permission|location access/i.test(errorMessage(error)) ? 'permission-denied' : 'error';
}

function profileSignature(
  profile: NonNullable<ReturnType<typeof useCryptidProfile>['profile']>
): string {
  return `${profile.handle}\u0000${profile.cryptidName}\u0000${profile.sigil}\u0000${profile.color}`;
}

/**
 * The native `IrohLocation` module is a process-wide singleton that owns a single node, and the
 * background location service is meant to outlive any single mount of this provider. So the service
 * (and its native node) is held as a module-level singleton: remounts — including React StrictMode's
 * dev double-invoke — reuse it and re-attach listeners, rather than create a second service that
 * would race the shared native node. That race surfaced as `IrohLocation.setPairingReady` rejecting
 * with "call createNode first" when a stale unmount tore the node down under a freshly-mounted,
 * already-"ready" instance. Initialised exactly once; a failed attempt clears the latch so a later
 * mount can retry instead of inheriting a rejected promise.
 */
let sharedService: LocationSharingService | null = null;
let sharedServiceInit: Promise<void> | null = null;

function getSharedService(): LocationSharingService {
  if (!sharedService) sharedService = new LocationSharingService();
  return sharedService;
}

export function LocationSharingProvider({ children }: PropsWithChildren) {
  const { profile } = useCryptidProfile();
  const [initialProfile] = useState(profile);
  const serviceRef = useRef<LocationSharingService | null>(null);
  const bluetoothPermissionGranted = useRef(false);
  const trailRefreshId = useRef(0);
  const publishedProfileSignature = useRef('');
  const [snapshot, setSnapshot] = useState<SharingSnapshot | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [persistedSelfFix, setPersistedSelfFix] = useState<LocationFix | null>(null);
  const [liveSelfFix, setLiveSelfFix] = useState<LocationFix | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationRuntimeStatus>('starting');
  const [locationError, setLocationError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);

  const refreshTrail = useCallback(async (service: LocationSharingService): Promise<void> => {
    const requestId = ++trailRefreshId.current;
    const latest = await service.trailLatest();
    if (requestId !== trailRefreshId.current) return;
    setTrail(latest);
    const persistedSelf = latest.find((point) => point.author === SELF_AUTHOR)?.fix;
    if (persistedSelf) {
      setPersistedSelfFix((current) =>
        !current || persistedSelf.ts > current.ts ? persistedSelf : current
      );
    }
  }, []);

  const startLocation = useCallback(async (service: LocationSharingService): Promise<void> => {
    if (!(await service.isBackgroundAvailable())) {
      setLocationStatus('unavailable');
      setLocationError('Background location is unavailable in this build.');
      return;
    }
    try {
      setLocationStatus('starting');
      const access = await service.startBackground();
      if (access === 'full') {
        setLocationStatus('running');
        setLocationError(null);
      } else {
        setLocationStatus('permission-denied');
        setLocationError('Allow background location so your friends stay current.');
      }
    } catch (startError: unknown) {
      setLocationStatus(locationStatusFor(startError));
      setLocationError(errorMessage(startError));
    }
  }, []);

  useEffect(() => {
    if (locationStatus !== 'permission-denied') return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const service = serviceRef.current;
      if (!service) return;
      void service.stopBackground().then(() => startLocation(service));
    });
    return () => subscription.remove();
  }, [locationStatus, startLocation]);

  useEffect(() => {
    if (!initialProfile) return;

    const service = getSharedService();
    serviceRef.current = service;
    let active = true;

    const offSnapshot = service.onChange((next) => {
      if (active) setSnapshot(next);
    });
    const offLocalFix = service.onLocalFix((fix) => {
      if (!active) return;
      setLiveSelfFix((current) => (!current || fix.ts >= current.ts ? fix : current));
    });
    const offTrail = service.onTrailChange(() => {
      if (active) void refreshTrail(service);
    });
    const offFix = service.onFix((_fix: IncomingFix) => {
      if (active) void refreshTrail(service);
    });
    const offError = service.onError((message) => {
      // An empty message is the service's "recovered" signal — clear the banner rather than pin it.
      if (active) setServiceError(message || null);
    });

    void (async () => {
      if (!LocationSharingService.isAvailable()) {
        if (active) {
          setLocationStatus('unavailable');
          setServiceError('Friend sync needs an installed Android or iOS build.');
        }
        return;
      }
      try {
        // Initialise the shared native node exactly once across all mounts. A failed attempt
        // clears the latch (below) so a later mount retries rather than awaiting a rejected promise.
        if (!sharedServiceInit) {
          sharedServiceInit = (async () => {
            await ensureLocalNetworkPermission();
            bluetoothPermissionGranted.current = await ensurePairingPermissions();
            await service.init(
              initialProfile.handle,
              initialProfile.sigil,
              initialProfile.cryptidName,
              initialProfile.color
            );
          })().catch((error: unknown) => {
            sharedServiceInit = null;
            throw error;
          });
        }
        await sharedServiceInit;
        publishedProfileSignature.current = profileSignature(initialProfile);
        if (!active) return;
        await refreshTrail(service);
        await startLocation(service);
        await service.syncTrail(0);
      } catch (initError: unknown) {
        if (!active) return;
        setLocationStatus('error');
        setServiceError(errorMessage(initError));
      }
    })();

    return () => {
      // Detach this mount's listeners only. The shared service, its native node, and the background
      // location service are process-lifetime singletons and are intentionally NOT shut down here,
      // so a remount (or StrictMode's dev double-invoke) can't tear the node down under another
      // still-live, already-"ready" instance.
      active = false;
      trailRefreshId.current += 1;
      offSnapshot();
      offLocalFix();
      offTrail();
      offFix();
      offError();
    };
  }, [initialProfile, refreshTrail, startLocation]);

  useEffect(() => {
    if (!profile || !snapshot?.ready) return;
    const signature = profileSignature(profile);
    if (signature === publishedProfileSignature.current) return;
    const service = serviceRef.current;
    if (!service) return;
    void service
      .updateProfile(profile.handle, profile.sigil, profile.cryptidName, profile.color)
      .then(() => {
        publishedProfileSignature.current = signature;
      })
      .catch((profileError: unknown) => {
        setServiceError(errorMessage(profileError));
      });
  }, [profile, snapshot?.ready]);

  const run = useCallback(async (action: (service: LocationSharingService) => Promise<void>) => {
    const service = serviceRef.current;
    if (!service) return;
    try {
      await action(service);
    } catch (actionError: unknown) {
      setServiceError(errorMessage(actionError));
    }
  }, []);

  const setPairingReady = useCallback(
    async (ready: boolean) => {
      if (ready && !bluetoothPermissionGranted.current) {
        const granted = await ensurePairingPermissions();
        if (!granted) {
          setServiceError('Bluetooth access is needed to discover a nearby friend.');
          return;
        }
        bluetoothPermissionGranted.current = true;
      }
      setServiceError(null);
      await run((service) => service.setPairingReady(ready));
    },
    [run]
  );

  const createPairInvite = useCallback(async (ttlSecs = 300) => {
    const service = serviceRef.current;
    if (!service) return undefined;
    try {
      const link = await service.createPairInvite(ttlSecs);
      setServiceError(null);
      return link;
    } catch (inviteError: unknown) {
      setServiceError(errorMessage(inviteError));
      return undefined;
    }
  }, []);

  const retryLocation = useCallback(async () => {
    const service = serviceRef.current;
    if (!service) return;
    await service.stopBackground();
    await startLocation(service);
  }, [startLocation]);

  const hasLiveSelfFix = liveSelfFix !== null;
  const selfFix = liveSelfFix ?? persistedSelfFix;
  const beginNearbyGesture = useCallback(() => {
    setServiceError(null);
    return run((service) => service.beginNearbyGesture());
  }, [run]);
  const pairFromInput = useCallback(
    (input: string) => {
      setServiceError(null);
      return run((service) => service.pairFromInput(input).then(() => undefined));
    },
    [run]
  );
  const respondPair = useCallback(
    (sessionId: string, accept: boolean) => {
      setServiceError(null);
      return run((service) => service.respondPair(sessionId, accept));
    },
    [run]
  );
  const refreshPairing = useCallback(() => run((service) => service.refreshPairing()), [run]);
  const toggleShare = useCallback(
    (endpointId: string, on: boolean) => {
      setServiceError(null);
      return run((service) => (on ? service.shareWith(endpointId) : service.revoke(endpointId)));
    },
    [run]
  );
  const clearPairingCelebration = useCallback(() => {
    serviceRef.current?.clearPairingCelebration();
  }, []);

  const friends = useMemo(
    () =>
      buildFriendPresence({
        friends: snapshot?.friends ?? [],
        latest: trail.filter((point) => point.author !== SELF_AUTHOR),
        selfFix: hasLiveSelfFix ? selfFix : null,
      }),
    [snapshot?.friends, trail, hasLiveSelfFix, selfFix]
  );
  const error = locationError ?? serviceError;

  const value = useMemo<LocationSharingContextValue>(
    () => ({
      snapshot,
      pairing: snapshot?.pairing ?? null,
      trail,
      selfFix,
      hasLiveSelfFix,
      friends,
      locationStatus,
      error,
      setPairingReady,
      beginNearbyGesture,
      createPairInvite,
      pairFromInput,
      respondPair,
      refreshPairing,
      toggleShare,
      retryLocation,
      clearPairingCelebration,
    }),
    [
      snapshot,
      trail,
      selfFix,
      hasLiveSelfFix,
      friends,
      locationStatus,
      error,
      setPairingReady,
      beginNearbyGesture,
      createPairInvite,
      pairFromInput,
      respondPair,
      refreshPairing,
      toggleShare,
      retryLocation,
      clearPairingCelebration,
    ]
  );

  return (
    <LocationSharingContext.Provider value={value}>{children}</LocationSharingContext.Provider>
  );
}

export function useLocationSharing(): LocationSharingContextValue {
  const context = useContext(LocationSharingContext);
  if (!context) {
    throw new Error('useLocationSharing must be used inside LocationSharingProvider.');
  }
  return context;
}
