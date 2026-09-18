package com.unrealjune.irohlocation

import android.content.Context
import android.util.Log
import java.io.File
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import uniffi.iroh_location.BatteryState
import uniffi.iroh_location.FixListener
import uniffi.iroh_location.IngestOutcome
import uniffi.iroh_location.LocationFix
import uniffi.iroh_location.LocationNode
import uniffi.iroh_location.Subscription
import uniffi.iroh_location.deriveTopic

/**
 * An iroh node owned by the foreground service, for wakes with no JS context alive.
 *
 * This is the point of the whole native drain path. On 2026-08-29 a Pixel captured 446 real fixes
 * over eleven and a half hours while `expo-task-manager` spooled every one of them, because it
 * never managed to start a headless JS context to hand them to — the foreground service was
 * healthy and the GPS was working; the only missing piece was a JS runtime to own the queue.
 * Nothing here needs one.
 *
 * ## Why "already owned" is a normal outcome, not an error
 *
 * The Rust stores take a **process-wide directory claim** (see `durable.rs`), and a Service runs in
 * the app process. So when the app is mounted, its node holds the claim and [`ensureStarted`] fails
 * with `AlreadyOpen` — which is exactly right and needs no coordination between the two: a mounted
 * app is already running the same pipeline in JS, so the correct response is to stand down. That
 * the claim is structural rather than a flag two components agree to check is what makes this safe;
 * `native-runtime-owner.ts` documents what the flag version cost.
 */
internal object NativeBackgroundRuntime {
  private const val TAG = "IrohBgRuntime"

  private val lock = Mutex()
  private var node: LocationNode? = null
  private var subscription: Subscription? = null

  /** Inbound fixes still land in the durable replica; nothing here needs to surface them. */
  private object SilentListener : FixListener {
    override fun onFix(
      author: ByteArray,
      seq: ULong,
      fix: LocationFix,
      backfill: Boolean,
      via: String,
      viaPeer: String?,
    ) = Unit

    override fun onOpaque(author: ByteArray, seq: ULong) = Unit

    override fun onStatus(status: String) = Unit
  }

  /**
   * Build and start a node from platform-held state, unless one is already running.
   *
   * Returns false when this process should not have a background node — either the app owns it, or
   * the device has no identity yet. Both are ordinary; neither is worth a crash or a retry loop.
   *
   * ## The refusal is the steady state, so it has to be remembered
   *
   * While the app is mounted the claim is refused on **every** call, by design — see the class
   * docs. What was not by design is that the failure path remembered nothing, so every capture
   * rebuilt a whole [LocationNode] (a keygen, a `derive_recv_public` KDF, fifteen mutexes and a
   * `telemetry::init_tracing`) purely to be refused again, and `node.construct` incremented a
   * process-wide ordinal it then WARNs about. A Pixel 10 logged 86 constructions with zero
   * shutdowns in five hours; the iOS runtime, whose deliveries are far denser, reached 187 in one
   * minute on 2026-09-16 and took a CPU exception for it.
   *
   * A refusal therefore suppresses the next few attempts, to a ceiling of
   * [CLAIM_RETRY_CEILING_MS]. [stop] clears the suppression outright, because its whole contract is
   * that the app can take the claim back immediately. The ceiling is bounded rather than a latch
   * for the case [stop] is never reached — a crash on the JS side — since a latch there would be a
   * phone that never publishes again and never says why.
   */
  suspend fun ensureStarted(context: Context): Boolean =
    lock.withLock {
      if (subscription != null) return@withLock true
      if (System.currentTimeMillis() < claimRetryAfterMs) return@withLock false
      val app = context.applicationContext
      IrohAndroidBootstrap.install(app)

      val secrets = KeystoreDeviceSecrets(app)
      if (secrets.identitySecret() == null) {
        // A fresh install whose app has never run. Minting an identity here would create one no
        // friend has ever paired with and silently orphan the one the app makes later.
        Log.i(TAG, "no device identity yet; the app has not been opened")
        return@withLock false
      }

      try {
        // Same two roots, same opposite requirements as `createNode` — cacheDir for the replica,
        // filesDir for state that must survive a cache purge (FORWARD-SECRECY.md §4.2).
        val built =
          LocationNode.fromDeviceSecrets(
            secrets,
            File(app.cacheDir, "streetcryptid").absolutePath,
            File(app.filesDir, "streetcryptid").absolutePath,
          )
        built.startStored()
        val sub = built.subscribe(deriveTopic(built.endpointId()), emptyList(), SilentListener)
        node = built
        subscription = sub
        val recovered = if (claimRefusals > 0) " after $claimRefusals refused claim(s)" else ""
        Log.i(TAG, "background node started$recovered")
        clearClaimBackoff()
        true
      } catch (e: Exception) {
        // `AlreadyOpen` from the store claim is the common one and means the app is mounted and
        // already publishing — see the class docs. It is logged at info because on a phone the user
        // is actively looking at, it is the expected path, not a fault. Only the first of a run is
        // logged: at one line per capture this was itself part of the load it reports.
        if (claimRefusals == 0) Log.i(TAG, "background node not started: ${e.message}")
        dropNodeHandlesLocked()
        backOffFromRefusedClaim()
        false
      }
    }

  /** How long to wait after the first refused claim before building a node again. */
  private const val CLAIM_RETRY_FLOOR_MS = 5_000L

  /**
   * The longest a refusal may suppress a rebuild. See [ensureStarted] for why this is not a latch.
   */
  private const val CLAIM_RETRY_CEILING_MS = 60_000L

  /** Consecutive refused store claims. Reset by a success or by [stop]. */
  private var claimRefusals = 0

  /** Wall clock before which [ensureStarted] will not attempt a build. */
  private var claimRetryAfterMs = 0L

  private fun backOffFromRefusedClaim() {
    claimRefusals += 1
    val delay =
      (CLAIM_RETRY_FLOOR_MS shl (claimRefusals - 1).coerceAtMost(10))
        .coerceAtMost(CLAIM_RETRY_CEILING_MS)
    claimRetryAfterMs = System.currentTimeMillis() + delay
  }

  private fun clearClaimBackoff() {
    claimRefusals = 0
    claimRetryAfterMs = 0L
  }

  /**
   * What happened to one captured location, in the three ways it can differ for the caller.
   *
   * Three cases and not a nullable outcome, because two of them used to be the same `null` and the
   * difference is the whole bug: "the app owns the node" needs the fix handed to the app, while
   * "the relay blinked" needs it left in the native queue for the next wake. Collapsing them meant
   * every capture taken while the app was alive went on the floor.
   */
  sealed interface Capture {
    /** The fix went through the native pipeline here. */
    data class Ingested(val outcome: IngestOutcome) : Capture

    /**
     * The mounted app holds the process-wide store claim, so this runtime cannot publish and the
     * app is the only thing that can. Hand the fix up rather than dropping it.
     */
    data object AppOwnsNode : Capture

    /** No identity yet, or the ingest threw. The fix stays queued; the next wake retries. */
    data object Unavailable : Capture
  }

  /**
   * Take one captured location as far towards the wire as this moment allows.
   *
   * [Capture.AppOwnsNode] is the ordinary outcome whenever the app is open — see the class docs —
   * and it is emphatically not "nothing to do": the caller must pass the fix to the app, because
   * the JS pipeline that used to cover the mounted case no longer exists.
   */
  suspend fun ingest(
    context: Context,
    fix: LocationFix,
    battery: BatteryState,
    intervalMs: ULong,
  ): Capture {
    if (!ensureStarted(context)) {
      // `ensureStarted` returns false both for the store claim and for a device with no identity.
      // Only the first has somewhere to hand the fix to: with no identity there is no app node
      // either, so there is nothing that could publish it.
      return if (hasIdentity(context)) Capture.AppOwnsNode else Capture.Unavailable
    }
    val sub = lock.withLock { subscription } ?: return Capture.Unavailable
    return try {
      Capture.Ingested(
        sub.ingestFix(
          SUBSCRIPTION_ID,
          fix,
          battery,
          intervalMs,
          System.currentTimeMillis().toULong(),
        )
      )
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
    if (!ensureStarted(context)) {
      return if (hasIdentity(context)) Capture.AppOwnsNode else Capture.Unavailable
    }
    val sub = lock.withLock { subscription } ?: return Capture.Unavailable
    return try {
      Capture.Ingested(
        sub.heartbeatFix(
          SUBSCRIPTION_ID,
          battery,
          intervalMs,
          System.currentTimeMillis().toULong(),
        )
      )
    } catch (e: Exception) {
      // Same reasoning as `ingest`: a transient relay error must not take down the service. The
      // anchor is still in the gate, so the next tick republishes it.
      Log.w(TAG, "heartbeat failed; the anchor stays queued", e)
      Capture.Unavailable
    }
  }

  /** Whether this device has an identity at all — the one case a handoff cannot help. */
  private fun hasIdentity(context: Context): Boolean =
    try {
      KeystoreDeviceSecrets(context.applicationContext).identitySecret() != null
    } catch (e: Exception) {
      Log.w(TAG, "could not read the device identity", e)
      false
    }

  /** Release the node and, with it, every directory claim, so the app can take them back. */
  suspend fun stop() = lock.withLock { stopLocked() }

  private fun stopLocked() {
    // Before the early return below: after a refused claim there is no node to close, and that is
    // precisely the state whose suppression has to be lifted.
    clearClaimBackoff()
    dropNodeHandlesLocked()
  }

  /**
   * Drop the node handles WITHOUT touching the backoff.
   *
   * Split from [stopLocked] deliberately: the refusal path must not clear the very suppression it
   * is setting. Collapsing these two back together restores the rebuild-per-capture loop.
   */
  private fun dropNodeHandlesLocked() {
    subscription = null
    val current = node ?: return
    node = null
    try {
      // Best-effort and deliberately not awaited beyond the call: teardown that hangs must not
      // wedge the service. `HEADLESS_TEARDOWN_TIMEOUT_MS` in headless-runtime.ts records what that
      // cost on iOS when it was allowed to.
      current.close()
    } catch (e: Exception) {
      Log.w(TAG, "background node teardown failed", e)
    }
  }

  /**
   * Accepted for API parity and ignored: a node owns a single trail namespace, so the Rust side
   * takes this as `_subscription_id`. Named rather than passed as `""` so a reader does not go
   * looking for the map it would have to have come from.
   */
  private const val SUBSCRIPTION_ID = "background"
}
