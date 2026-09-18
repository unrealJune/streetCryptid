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
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
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
   * The publish cadence.
   *
   * It is the *slot* interval, not the sampling rate: the gate absorbs everything that arrives
   * inside a slot, so requesting updates more often than this costs battery and publishes nothing
   * extra. What it does buy is a fresher position at the moment a slot comes due.
   *
   * Held in the companion so the cadence controller can change it without a handle on the running
   * service — Android gives callers a component name, not an instance. It used to be a constant,
   * which meant a service that quietly ignored the interval the app was showing the user.
   */
  private val slotIntervalMs: ULong
    get() = cadenceSlotIntervalMs

  private val listener =
    LocationListener { location ->
      // Stamped before the launch, not inside it: the ticker asks "did the provider deliver in this
      // slot", and a coroutine that has been dispatched but not yet run still answers yes.
      lastDeliveryAtMs = System.currentTimeMillis()
      // Straight into the native path. No JS, no headless bridge, no spool.
      scope.launch { publish(location) }
    }

  /**
   * When the provider last handed us a location, or 0 before the first one.
   *
   * The only state the stationary ticker needs. Deliberately not a "moving/stopped" state machine
   * like the iOS runtime's: that exists there because Core Location has to be re-tiered to a
   * cheaper stream to keep the process ALIVE, and a foreground service has no such problem.
   */
  @Volatile private var lastDeliveryAtMs: Long = 0L

  private var stationaryTicker: Job? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    startForeground(NOTIFICATION_ID, notification())
    running = true
    startLocationUpdates()
    startStationaryTicker()
  }

  /**
   * `START_REDELIVER_INTENT`, matching what `expo-location`'s own service uses: a process kill
   * should bring the service back with its intent rather than silently drop sharing until the user
   * next opens the app.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_REDELIVER_INTENT

  override fun onDestroy() {
    running = false
    stationaryTicker?.cancel()
    stationaryTicker = null
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
          cadenceDistanceM,
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

  /**
   * Publish a parked heartbeat for every slot the provider does not deliver into.
   *
   * ## Why this has to exist
   *
   * `LocationManager.requestLocationUpdates` delivers only when BOTH `MIN_UPDATE_INTERVAL_MS` has
   * elapsed AND the device has moved `cadenceDistanceM`. With a 50 m filter a phone on a desk
   * produces **no callbacks at all, indefinitely** — so the send path simply never ran, and the
   * only thing publishing a stationary Pixel's position was the deferrable `expo-background-task`
   * refresh. On 2026-09-18 App Standby decayed that from a run every ~16 minutes to one in fourteen
   * hours, and the phone went silent for 7.8 of them with `task.location_running = true`,
   * `perm.background = granted` and every other flag green. That is the same shape the iOS runtime
   * was rewritten to fix (see `BackgroundLocationRuntime.swift`, 2026-08-30); Android never got the
   * other half.
   *
   * ## Why a plain timer is the right answer HERE
   *
   * iOS cannot do this — it has no clock that survives suspension, which is why that side has to be
   * parasitic on Core Location and re-tier to a coarse stream to stay alive at all. A foreground
   * service is exempt from Doze and App Standby, so on Android the clock is simply available. Using
   * it means the parked heartbeat stops depending on WorkManager, which is the component that
   * actually failed.
   *
   * Lowering `cadenceDistanceM` to zero would also produce deliveries, and is the wrong fix twice
   * over: it spins GPS for positions the gate will discard, and it routes them through `ingest`,
   * where failing the movement test stamps `FIX_STATE_NO_FIX` — "moving, no signal fix" on a
   * friend's screen, for a phone that is parked. The heartbeat path stamps `FIX_STATE_PARKED`,
   * which is true.
   *
   * The tick is skipped whenever the provider has delivered inside the current slot, so a moving
   * phone costs nothing and never publishes twice for one slot. `heartbeatFix` is idempotent
   * against the slot grid anyway (`gate::due_slots` returns 0 when none are due), so a race between
   * a late delivery and a tick is absorbed rather than duplicated.
   */
  private fun startStationaryTicker() {
    stationaryTicker?.cancel()
    stationaryTicker =
      scope.launch {
        while (isActive && running) {
          val slotMs = slotIntervalMs.toLong().coerceAtLeast(MIN_TICK_INTERVAL_MS)
          delay(slotMs)
          if (!running) break
          val since = System.currentTimeMillis() - lastDeliveryAtMs
          // A delivery inside this slot means `publish` has already run the gate for it.
          if (lastDeliveryAtMs != 0L && since < slotMs) continue
          heartbeat()
        }
      }
  }

  private suspend fun heartbeat() {
    val battery = readBattery()
    when (NativeBackgroundRuntime.heartbeat(applicationContext, battery, slotIntervalMs)) {
      is NativeBackgroundRuntime.Capture.Ingested -> Unit
      // Same handover as a capture, and for the same reason — while the app is mounted it holds the
      // store claim and is the only thing that can publish. `null` fix: a parked tick has no
      // position, and `routeNativeCapture` reads `kind` to know that.
      NativeBackgroundRuntime.Capture.AppOwnsNode ->
        IrohLocationModule.handOffCapture(
          fix = null,
          battery = battery,
          reason = "periodic",
          kind = "heartbeat",
          state = "stopped",
        )
      NativeBackgroundRuntime.Capture.Unavailable -> Unit
    }
  }

  private suspend fun publish(location: Location) {
    val fix = location.toFix()
    val battery = readBattery()
    when (val capture =
      NativeBackgroundRuntime.ingest(applicationContext, fix, battery, slotIntervalMs)
    ) {
      is NativeBackgroundRuntime.Capture.Ingested -> {
        val outcome = capture.outcome
        // One line per wake that did something, so a quiet phone and a broken one look different
        // in logcat. The equivalent spans reach the collector from the Rust side.
        if (outcome.enqueued > 0u || outcome.published > 0u) {
          Log.i(
            TAG,
            "wake: enqueued=${outcome.enqueued} published=${outcome.published} " +
              "pending=${outcome.pending} skipped=${outcome.slotsSkipped} " +
              "dropped=${outcome.overflowDropped} suspended=${outcome.suspended}",
          )
        }
      }
      // The ordinary outcome whenever the app is alive: the store claim is process-wide, so the
      // mounted runtime owns the node and is the only thing that can publish this. Handing it over
      // IS the mounted path — dropping here is what left a Pixel silent for fifteen hours with a
      // perfectly healthy service running.
      NativeBackgroundRuntime.Capture.AppOwnsNode ->
        if (!IrohLocationModule.handOffCapture(fix, battery, reason = "movement")) {
          // Sharing is off, or the module was torn down without stopping the service. Unlike the
          // queued cases this fix is simply gone, so say so rather than letting it look routine.
          Log.w(TAG, "capture dropped: the app owns the node but nothing is listening for handoff")
        }
      // No identity, or the ingest threw. The fix stays in the native outbox for the next wake.
      NativeBackgroundRuntime.Capture.Unavailable -> Unit
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
      // Capture-side: the envelope stamps belong to a send that has not happened yet.
      state = null,
      publishedDeltaS = null,
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

    /** Set by {@link setCadence}; read by the running service on its next fix. */
    @Volatile private var cadenceSlotIntervalMs: ULong = 5UL * 60UL * 1000UL
    @Volatile private var cadenceDistanceM: Float = 50f
    @Volatile private var running = false

    /** Whether the service is the one currently receiving locations. Reported by `device.health`. */
    fun isRunning(): Boolean = running

    /**
     * Re-program from the sampling policy's decision.
     *
     * Stored rather than applied directly: `LocationManager` has no re-arm, so a distance change
     * takes effect when the service next re-requests. The slot interval applies immediately,
     * because it is enforced on our side rather than by the provider.
     */
    fun setCadence(context: Context, intervalMs: Long, distanceM: Float) {
      cadenceSlotIntervalMs = intervalMs.coerceAtLeast(1L).toULong()
      if (distanceM != cadenceDistanceM) {
        cadenceDistanceM = distanceM
        // Cheapest correct re-arm: the service re-requests on start, and startForegroundService on
        // an already-running service just re-delivers the intent.
        if (running) start(context)
      }
    }
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

    /**
     * Floor on the stationary tick, independent of the user's chosen slot interval.
     *
     * The interval is user-selectable down to one minute (`SHARE_INTERVAL_OPTIONS_MS`), and a
     * heartbeat is cheap — no GPS, one sealed envelope — but this stops a future cadence change
     * from turning the ticker into a spin loop.
     */
    private const val MIN_TICK_INTERVAL_MS = 60_000L

    fun start(context: Context) {
      val intent = Intent(context, BackgroundLocationService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, BackgroundLocationService::class.java))
    }
  }
}
