package com.unrealjune.irohlocation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import uniffi.iroh_location.BatteryState
import uniffi.iroh_location.LocationFix

/**
 * A foreground service that takes each location straight to the wire, with no JS in the loop.
 *
 * The failure this replaces: `expo-location`'s task hands fixes to `expo-task-manager`, which needs
 * a headless JS context to deliver them to. When that context does not start — for eleven and a
 * half hours on a Pixel on 2026-08-29 — the events spool on disk and nothing publishes, while the
 * foreground service, the GPS and the outbox all look perfectly healthy. Here the same callback
 * that receives the location also seals and sends it.
 *
 * ## Why `LocationManager` rather than the fused provider
 *
 * `FusedLocationProviderClient` would mean a Play Services dependency this module does not have,
 * and a hard one — a device without Play Services would lose background sharing entirely. At an
 * ambient five-minute cadence the platform provider is more than good enough, and the fix quality
 * gate (`gate.rs`) already discards what it should.
 *
 * ## Relationship to the JS pipeline
 *
 * They cannot both run: the Rust stores take a process-wide directory claim, so whichever starts
 * first owns the counter and the queue and the other stands down. That is deliberate and needs no
 * agreement between them — see [`NativeBackgroundRuntime`].
 */
class BackgroundLocationService : Service() {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var locationManager: LocationManager? = null

  /**
   * The publish cadence, mirroring `DEFAULT_SHARE_INTERVAL_MS`.
   *
   * It is the *slot* interval, not the sampling rate: the gate absorbs everything that arrives
   * inside a slot, so requesting updates more often than this costs battery and publishes nothing
   * extra. What it does buy is a fresher position at the moment a slot comes due.
   */
  private val slotIntervalMs: ULong = 5UL * 60UL * 1000UL

  private val listener =
    LocationListener { location ->
      // Straight into the native path. No JS, no headless bridge, no spool.
      scope.launch { publish(location) }
    }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    startForeground(NOTIFICATION_ID, notification())
    startLocationUpdates()
  }

  /**
   * `START_REDELIVER_INTENT`, matching what `expo-location`'s own service uses: a process kill
   * should bring the service back with its intent rather than silently drop sharing until the user
   * next opens the app.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_REDELIVER_INTENT

  override fun onDestroy() {
    locationManager?.removeUpdates(listener)
    locationManager = null
    // Release the directory claims so a mounted app can take them back immediately, rather than
    // failing its first `createNode` until this process happens to be reaped.
    scope.launch { NativeBackgroundRuntime.stop() }
    scope.cancel()
    super.onDestroy()
  }

  private fun startLocationUpdates() {
    val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
    if (manager == null) {
      Log.w(TAG, "no LocationManager; background sharing cannot start")
      stopSelf()
      return
    }
    locationManager = manager
    // Both providers, deliberately. GPS alone goes quiet indoors, which is where a phone spends
    // most of its day, and the network provider is what keeps a trail alive in a building.
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      try {
        manager.requestLocationUpdates(
          provider,
          MIN_UPDATE_INTERVAL_MS,
          MIN_UPDATE_DISTANCE_M,
          listener,
          Looper.getMainLooper(),
        )
      } catch (e: SecurityException) {
        // Permission revoked while running. Not fatal — the other provider may still be permitted,
        // and the app surfaces the permission state itself.
        Log.w(TAG, "location permission refused for $provider", e)
      } catch (e: IllegalArgumentException) {
        Log.i(TAG, "provider $provider is unavailable on this device")
      }
    }
  }

  private suspend fun publish(location: Location) {
    val outcome =
      NativeBackgroundRuntime.ingest(
        applicationContext,
        location.toFix(),
        readBattery(),
        slotIntervalMs,
      ) ?: return
    // One line per wake that did something, so a quiet phone and a broken one look different in
    // logcat. The equivalent spans reach the collector from the Rust side.
    if (outcome.enqueued > 0u || outcome.published > 0u) {
      Log.i(
        TAG,
        "wake: enqueued=${outcome.enqueued} published=${outcome.published} " +
          "pending=${outcome.pending} skipped=${outcome.slotsSkipped} " +
          "dropped=${outcome.overflowDropped} suspended=${outcome.suspended}",
      )
    }
  }

  private fun Location.toFix(): LocationFix =
    LocationFix(
      lat = latitude,
      lon = longitude,
      // `hasAccuracy()` false means the provider gave us no radius, NOT a perfect one. Zero is how
      // the gate spells "untestable", so it skips the accuracy check rather than silently passing.
      accuracyM = if (hasAccuracy()) accuracy.toDouble() else 0.0,
      headingDeg = if (hasBearing()) bearing.toDouble() else 0.0,
      ts = time.toULong(),
    )

  /**
   * Battery inputs for the suspend decision.
   *
   * Unknown reports as full rather than empty: the gate treats a critical level as a hard stop, so
   * a device whose battery API we cannot read must not look flat and stop publishing forever.
   */
  private fun readBattery(): BatteryState {
    val status =
      registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        ?: return BatteryState(level = 1.0, charging = false, lowPower = false)
    val level = status.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = status.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val plugged = status.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
    val power = getSystemService(Context.POWER_SERVICE) as? PowerManager
    return BatteryState(
      level = if (level >= 0 && scale > 0) level.toDouble() / scale.toDouble() else 1.0,
      charging = plugged != 0,
      lowPower = power?.isPowerSaveMode ?: false,
    )
  }

  private fun notification(): Notification {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      // IMPORTANCE_LOW: required for an ongoing location service, and silent — a persistent
      // notification that made a sound every time the service restarted would be intolerable.
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Location sharing", NotificationManager.IMPORTANCE_LOW)
      )
    }
    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Sharing your location")
      .setContentText("Your friends can see where you are.")
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val TAG = "IrohBgService"
    private const val CHANNEL_ID = "streetcryptid.location-sharing"
    private const val NOTIFICATION_ID = 0x5C10

    /**
     * Ask the OS for updates far more often than we publish, and let the gate absorb the rest.
     *
     * The slot grid decides what actually goes out, so a tighter request does not increase the
     * publish rate — it only means the fix that lands on a slot boundary is recent rather than
     * minutes old. One minute and fifty metres is the same shape `AMBIENT_*` uses in JS.
     */
    private const val MIN_UPDATE_INTERVAL_MS = 60_000L
    private const val MIN_UPDATE_DISTANCE_M = 50f

    fun start(context: Context) {
      val intent = Intent(context, BackgroundLocationService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, BackgroundLocationService::class.java))
    }
  }
}
