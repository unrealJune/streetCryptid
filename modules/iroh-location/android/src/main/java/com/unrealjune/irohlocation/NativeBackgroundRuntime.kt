package com.unrealjune.irohlocation

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import uniffi.iroh_location.BatteryState
import uniffi.iroh_location.IngestOutcome
import uniffi.iroh_location.LocationFix
import uniffi.iroh_location.NodeHolder
import uniffi.iroh_location.Subscription

/**
 * The foreground service's way onto the network, for wakes with no JS context alive.
 *
 * This is the point of the whole native drain path. On 2026-08-29 a Pixel captured 446 real fixes
 * over eleven and a half hours while `expo-task-manager` spooled every one of them, because it
 * never managed to start a headless JS context to hand them to — the foreground service was
 * healthy and the GPS was working; the only missing piece was a JS runtime to own the queue.
 * Nothing here needs one.
 *
 * ## It does not own a node
 *
 * It used to build its own, and the process-wide store claim (`durable.rs`) refused whichever of
 * it and the mounted app asked second. Every Android background bug since 2026-09-16 lived in that
 * gap: a node built per capture just to be refused, a backoff to throttle that, a sink gate to stop
 * it, and finally — 2026-10-03 — a node built in the seconds between the app's `createNode` and its
 * `start()`, which cost the app its own stores for 13.7 hours.
 *
 * Now there is ONE node per process, built only by `NodeHost` (Rust, `host.rs`), and this runtime
 * holds a lease on it like any other holder. Whoever built it, this publishes through it; nothing
 * here can be refused, so nothing here backs off.
 *
 * ## Routing is not ownership
 *
 * While the app is mounted and wired ([IrohLocationModule.appIsWired]) a capture still goes to JS
 * rather than straight into the pipeline — not because the app owns the stores, but because the
 * app runs the sampling policy and draws the user's own marker from what the gate accepted. Both
 * paths end in the same `ingestFix` on the same node.
 */
internal object NativeBackgroundRuntime {
  private const val TAG = "IrohBgRuntime"

  @Volatile private var loggedNoIdentity = false

  /**
   * The own-topic subscription on the process's node, taking the background lease if needed.
   *
   * `null` when the device has no identity yet — a fresh install whose app has never run, where
   * minting one would create an identity no friend has ever paired with — or when the node could
   * not be started. Both are retried by the next capture.
   *
   * `ownSubscription(…, null)` never replaces the app's listener: if JS is alive it keeps hearing
   * its own topic, and if it is not, the subscription is silent and the replica still fills.
   */
  private suspend fun ownSubscription(context: Context): Subscription? {
    val app = context.applicationContext
    IrohAndroidBootstrap.install(app)
    val node =
      try {
        NodeStorage.host.acquireBackground(
          KeystoreDeviceSecrets(app),
          NodeStorage.dataRoot(app),
          NodeStorage.stateRoot(app),
        )
      } catch (e: Exception) {
        Log.w(TAG, "background node unavailable; the next capture retries", e)
        return null
      }
    if (node == null) {
      if (!loggedNoIdentity) {
        Log.i(TAG, "no device identity yet; the app has not been opened")
        loggedNoIdentity = true
      }
      return null
    }
    return try {
      node.ownSubscription(emptyList(), null)
    } catch (e: Exception) {
      Log.w(TAG, "own-topic subscription unavailable; the next capture retries", e)
      null
    }
  }

  /**
   * What happened to one captured location, in the three ways it can differ for the caller.
   *
   * Three cases and not a nullable outcome, because two of them used to be the same `null` and the
   * difference is the whole bug: "the app processes captures" needs the fix handed to the app,
   * while "the relay blinked" needs it left in the native queue for the next wake. Collapsing them
   * meant every capture taken while the app was alive went on the floor.
   */
  sealed interface Capture {
    /** The fix went through the native pipeline here. */
    data class Ingested(val outcome: IngestOutcome) : Capture

    /**
     * A mounted app is wired to receive captures: hand the fix up. It ingests it through the same
     * node, after running the sampling policy and before drawing the user's marker.
     */
    data object HandToApp : Capture

    /** No identity yet, or the ingest threw. The next wake retries. */
    data object Unavailable : Capture
  }

  /**
   * Take one captured location as far towards the wire as this moment allows.
   *
   * [Capture.HandToApp] is the ordinary outcome whenever the app is open, and it is emphatically
   * not "nothing to do": the caller must pass the fix to the app.
   */
  suspend fun ingest(
    context: Context,
    fix: LocationFix,
    battery: BatteryState,
    intervalMs: ULong,
  ): Capture {
    if (IrohLocationModule.appIsWired()) return Capture.HandToApp
    val sub = ownSubscription(context) ?: return Capture.Unavailable
    return try {
      val outcome =
        sub.ingestFix(
          SUBSCRIPTION_ID,
          fix,
          battery,
          intervalMs,
          System.currentTimeMillis().toULong(),
        )
      pullFriendFixes(context)
      Capture.Ingested(outcome)
    } catch (e: Exception) {
      // The fix stays in the native outbox, so the next wake retries it. Failing loudly here would
      // take down a foreground service over a transient relay error.
      Log.w(TAG, "ingest failed; the fix stays queued", e)
      Capture.Unavailable
    }
  }

  /**
   * Fill the slots that have come due with no new position, because the phone has not moved.
   *
   * The counterpart of [ingest] and the Android half of the seam `DrainEngine::heartbeat` already
   * names — "iOS's parked coarse stream, Android's no-delivery tick". It exists because
   * `LocationManager.requestLocationUpdates` only delivers when BOTH the time and the distance
   * minimum are met, so a phone on a desk generates no callbacks at all and the publish path had
   * nothing to run it. A foreground service is not Doze-suspended, so unlike iOS we can simply
   * hold a clock — see [BackgroundLocationService.startStationaryTicker].
   *
   * Deliberately NOT an [ingest] of the last known position: the gate would judge it as a fresh
   * observation and stamp `FIX_STATE_NO_FIX` when it failed the movement test, which reads on a
   * friend's screen as "moving, no signal fix" — the opposite of the truth. `heartbeatFix` stamps
   * `FIX_STATE_PARKED`, which is the whole point of the declaration.
   */
  suspend fun heartbeat(
    context: Context,
    battery: BatteryState,
    intervalMs: ULong,
  ): Capture {
    if (IrohLocationModule.appIsWired()) return Capture.HandToApp
    val sub = ownSubscription(context) ?: return Capture.Unavailable
    return try {
      val outcome =
        sub.heartbeatFix(
          SUBSCRIPTION_ID,
          battery,
          intervalMs,
          System.currentTimeMillis().toULong(),
        )
      pullFriendFixes(context)
      Capture.Ingested(outcome)
    } catch (e: Exception) {
      // Same reasoning as `ingest`: a transient relay error must not take down the service. The
      // anchor is still in the gate, so the next tick republishes it.
      Log.w(TAG, "heartbeat failed; the anchor stays queued", e)
      Capture.Unavailable
    }
  }

  /**
   * Pull friends' new fixes, so a process with no JS alive RECEIVES as well as sends.
   *
   * The Android half of iOS's `pullFriendFixes`. With no JS alive, nothing else reconciles against
   * the stash, so without this a phone whose app the OS had killed published its own position on
   * time while every friend's dot on ITS map stayed wherever it was when the app died. Live gossip
   * still arrives, but only while both phones are online at the same moment; the stash is the part
   * that needs a pull.
   *
   * Floored at one pull per [SYNC_FLOOR_MS], durably, because `syncLatest` dials every delivery
   * peer and a pull on every delivery would spend the budget the whole native path exists to
   * protect. Failures are swallowed: the publish already succeeded, and the next wake retries.
   */
  private suspend fun pullFriendFixes(context: Context) {
    val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    if (now - prefs.getLong(LAST_SYNC_KEY, 0L) < SYNC_FLOOR_MS) return
    prefs.edit().putLong(LAST_SYNC_KEY, now).apply()
    val held = NodeStorage.host.current() ?: return
    try {
      val tickets = held.deliveryConfig().peerTickets
      if (tickets.isEmpty()) return
      held.syncLatest(tickets, null)
      Log.i(TAG, "pulled from ${tickets.size} peer(s)")
    } catch (e: Exception) {
      Log.w(TAG, "pull failed; the next wake retries", e)
    }
  }

  /**
   * Return the background lease, WITHOUT suspending the caller.
   *
   * For `BackgroundLocationService.onDestroy`, which used to `launch` the stop on its own scope and
   * cancel that scope on the next line — so the stop was cancelled before it was ever dispatched,
   * and turning sharing off left the stores held until the process died. This scope is never
   * cancelled, and the release is bounded by [STOP_TIMEOUT_MS].
   */
  fun stopDetached() {
    releaseScope.launch { stop() }
  }

  /**
   * Return the background lease. If the app holds the node too it keeps running; if not, the host
   * shuts it down and the stores are free.
   */
  suspend fun stop() {
    // Nothing loaded the native library, so nothing can hold a lease to return.
    if (!IrohAndroidBootstrap.installed) return
    try {
      NodeStorage.host.release(NodeHolder.BACKGROUND, STOP_TIMEOUT_MS)
    } catch (e: Exception) {
      Log.w(TAG, "background lease release failed", e)
    }
  }

  private const val PREFS = "iroh-location.background"
  private const val LAST_SYNC_KEY = "last_sync_ms"
  /** One pull per default publish slot: a phone in motion pulls about as often as it sends. */
  private const val SYNC_FLOOR_MS = 5 * 60 * 1000L

  /** Bounds a release nobody is waiting on; matches the app's own teardown budget. */
  private const val STOP_TIMEOUT_MS: ULong = 5_000UL

  /** Process-lifetime, never cancelled: see [stopDetached]. */
  private val releaseScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  /**
   * Accepted for API parity and ignored: a node owns a single trail namespace, so the Rust side
   * takes this as `_subscription_id`. Named rather than passed as `""` so a reader does not go
   * looking for the map it would have to have come from.
   */
  private const val SUBSCRIPTION_ID = "background"
}
