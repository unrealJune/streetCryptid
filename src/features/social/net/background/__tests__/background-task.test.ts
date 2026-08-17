import {
  BACKGROUND_LOCATION_TASK,
  rearmBackgroundLocationTask,
  type BackgroundStartConfig,
} from '../background-task';

const config: BackgroundStartConfig = {
  accuracy: 'balanced',
  timeIntervalMs: 300_000,
  distanceIntervalM: 100,
  notificationTitle: 'streetCryptid',
  notificationBody: "Keeping your friends' map current.",
};

describe('background location registration', () => {
  const makeApi = (started: boolean) => ({
    hasStartedLocationUpdatesAsync: jest.fn(async () => started),
    startLocationUpdatesAsync: jest.fn(async () => {}),
    stopLocationUpdatesAsync: jest.fn(async () => {}),
  });

  it('starts a new OS location task when none is registered', async () => {
    const api = makeApi(false);

    await rearmBackgroundLocationTask(api, config);

    expect(api.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(api.startLocationUpdatesAsync).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({
        timeInterval: 300_000,
        distanceInterval: 100,
      })
    );
  });

  // Expo's default is already false; we were explicitly opting IN to the blue status-bar pill.
  // Per Apple QA1965 an "Always"-authorized app can leave it off, which is what other location
  // sharing apps do — hence the persistent indicator users noticed on iOS.
  it('does not opt in to the iOS background location indicator', async () => {
    const api = makeApi(false);

    await rearmBackgroundLocationTask(api, config);

    expect(api.startLocationUpdatesAsync).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({ showsBackgroundLocationIndicator: false })
    );
  });

  it('restarts a persisted task so the foreground service resumes after force-stop', async () => {
    const api = makeApi(true);

    await rearmBackgroundLocationTask(api, config);

    expect(api.stopLocationUpdatesAsync).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
    expect(api.stopLocationUpdatesAsync.mock.invocationCallOrder[0]).toBeLessThan(
      api.startLocationUpdatesAsync.mock.invocationCallOrder[0]
    );
  });

  it('defaults to auto-pause for battery-efficient ambient sharing', async () => {
    const api = makeApi(false);

    await rearmBackgroundLocationTask(api, config);

    expect(api.startLocationUpdatesAsync).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({ pausesUpdatesAutomatically: true })
    );
  });

  it('passes the iOS activity hint, auto-pause, and Android notification color through', async () => {
    const api = makeApi(false);

    await rearmBackgroundLocationTask(api, {
      ...config,
      activityType: 'automotive',
      pausesUpdatesAutomatically: false,
      notificationColor: '#C6791A',
    });

    expect(api.startLocationUpdatesAsync).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({
        pausesUpdatesAutomatically: false,
        // expo-location ActivityType.AutomotiveNavigation === 2
        activityType: 2,
        foregroundService: expect.objectContaining({ notificationColor: '#C6791A' }),
      })
    );
  });
});
