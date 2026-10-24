package com.unrealjune.irohlocation

import android.location.Location
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import uniffi.iroh_location.LocationRuntimeEvent
import uniffi.iroh_location.LocationRuntimeKind
import uniffi.iroh_location.recordLocationRuntime

/**
 * `location.runtime` for the Android foreground service — the same span the iOS runtime emits,
 * from the process that is running whether or not JS is.
 *
 * Until 2026-10-13 a JS-free Android process said nothing about itself: `device.health` is emitted
 * by JS, and the service's own account went to logcat. So when the app process died and the
 * service carried on, the record went blank, and a working service and a dead one looked the same.
 * This makes absence measurable the way it is on iOS: a [pulse][startPulse] every five minutes
 * from a timer, NOT from the delivery path, so it still fires when deliveries stop.
 *
 * The vocabulary is `location_runtime.rs`'s. Android has no moving/stopped state machine, so
 * `location.state` is what the stationary ticker would conclude: `moving` if the provider has
 * delivered inside the current slot, `stopped` if not. `desired_accuracy_m` is 0 (both providers
 * are requested, with no accuracy target), and the fence fields are always false. Nothing carries
 * a coordinate.
 */
internal class LocationRuntimeReporter(
  private val scope: CoroutineScope,
  private val slotIntervalMs: () -> Long,
  private val distanceFilterM: () -> Float,
) {
  private val lock = Any()
  private var deliveries = 0u
  private var redeliveries = 0u
  private var workStarted = 0u
  private var workFinished = 0u
  private var handedOff = 0u
  private var lastDeliveryAtMs = 0L
  private var lastFixTimeMs = 0L
  private var fixAgeAtDeliveryMs: ULong? = null
  private var accuracyM: Double? = null
  private var speedMps: Double? = null
  private var stalled = false
  private var pulseJob: Job? = null
  private val main = Handler(Looper.getMainLooper())

  fun noteDelivery(location: Location) {
    val now = System.currentTimeMillis()
    synchronized(lock) {
      deliveries++
      if (location.time <= lastFixTimeMs) redeliveries++
      lastFixTimeMs = maxOf(lastFixTimeMs, location.time)
      lastDeliveryAtMs = now
      fixAgeAtDeliveryMs = (now - location.time).coerceAtLeast(0L).toULong()
      accuracyM = if (location.hasAccuracy()) location.accuracy.toDouble() else null
      speedMps = if (location.hasSpeed()) location.speed.toDouble() else -1.0
    }
  }

  fun noteWorkStarted() {
    synchronized(lock) { workStarted++ }
  }

  fun noteWorkFinished() {
    synchronized(lock) { workFinished++ }
  }

  fun noteHandOff() {
    synchronized(lock) { handedOff++ }
  }

  /** A discrete event (`started`, `location_error`, `authorization`). Counters are not reset. */
  fun event(kind: LocationRuntimeKind, reason: String? = null, detail: String? = null) {
    val event = synchronized(lock) { build(kind, reason, latencyMs = null, detail, reset = false) }
    record(event)
  }

  fun startPulse() {
    if (pulseJob?.isActive == true) return
    pulseJob =
      scope.launch {
        while (isActive) {
          delay(PULSE_INTERVAL_MS)
          pulse()
        }
      }
  }

  fun stopPulse() {
    pulseJob?.cancel()
    pulseJob = null
  }

  /**
   * Probe the main looper first — the platform provider delivers there, so a wedged main thread
   * means no deliveries whatever the OS is doing — then report. A stall is reported once, while it
   * is happening, as `main_stalled`.
   */
  private suspend fun pulse() {
    val sent = SystemClock.elapsedRealtime()
    val answered = CompletableDeferred<Unit>()
    main.post { answered.complete(Unit) }
    val ok = withTimeoutOrNull(MAIN_STALL_THRESHOLD_MS) { answered.await() } != null
    val latencyMs = (SystemClock.elapsedRealtime() - sent).coerceAtLeast(0L).toULong()
    val event =
      synchronized(lock) {
        when {
          ok -> {
            stalled = false
            build(LocationRuntimeKind.PULSE, reason = null, latencyMs, detail = null, reset = true)
          }
          !stalled -> {
            stalled = true
            build(LocationRuntimeKind.MAIN_STALLED, null, latencyMs, null, reset = true)
          }
          else -> null
        }
      } ?: return
    record(event)
    // The same five-minute clock, so a memory or network trend lines up with the runtime's own
    // record.
    ProcessMemorySampler.sample("pulse")
    NetworkHealthSampler.sample("pulse")
  }

  /** Called holding [lock]. */
  private fun build(
    kind: LocationRuntimeKind,
    reason: String?,
    latencyMs: ULong?,
    detail: String?,
    reset: Boolean,
  ): LocationRuntimeEvent {
    val now = System.currentTimeMillis()
    val sinceDelivery = if (lastDeliveryAtMs > 0L) now - lastDeliveryAtMs else null
    val moving = sinceDelivery != null && sinceDelivery < slotIntervalMs()
    val event =
      LocationRuntimeEvent(
        kind = kind,
        state = if (moving) "moving" else "stopped",
        reason = reason,
        deliveries = deliveries,
        redeliveries = redeliveries,
        workStarted = workStarted,
        workFinished = workFinished,
        handedOff = handedOff,
        lastDeliveryAgeMs = sinceDelivery?.coerceAtLeast(0L)?.toULong(),
        fixAgeAtDeliveryMs = fixAgeAtDeliveryMs,
        accuracyM = accuracyM,
        speedMps = speedMps,
        desiredAccuracyM = 0.0,
        distanceFilterM = distanceFilterM().toDouble(),
        mainLatencyMs = latencyMs,
        nodeOwner = if (IrohLocationModule.appIsWired()) "app" else "native",
        candidatePending = false,
        anchorArmed = false,
        fenceRegistered = false,
        detail = detail,
      )
    if (reset) {
      deliveries = 0u
      redeliveries = 0u
      handedOff = 0u
    }
    return event
  }

  private fun record(event: LocationRuntimeEvent) {
    // Nothing loaded the native library: there is no exporter to report to.
    if (!IrohAndroidBootstrap.installed) return
    try {
      recordLocationRuntime(event)
    } catch (e: Throwable) {
      Log.w(TAG, "location.runtime not recorded", e)
    }
  }

  private companion object {
    const val TAG = "IrohRuntimeReporter"
    const val PULSE_INTERVAL_MS = 5 * 60 * 1000L
    const val MAIN_STALL_THRESHOLD_MS = 10_000L
  }
}
