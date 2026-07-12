import {
  BACKGROUND_LOCATION_TASK,
  rearmBackgroundLocationTask,
  type BackgroundStartConfig,
} from '../background-task';

const config: BackgroundStartConfig = {
  accuracy: 'high',
  timeIntervalMs: 15_000,
  distanceIntervalM: 25,
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
        timeInterval: 15_000,
        distanceInterval: 25,
      })
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

  it('defaults to auto-pause with the "other" activity when unspecified', async () => {
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
