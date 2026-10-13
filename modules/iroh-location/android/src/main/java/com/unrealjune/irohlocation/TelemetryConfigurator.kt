package com.unrealjune.irohlocation

import android.content.Context
import android.os.Build
import android.util.Log
import uniffi.iroh_location.configureTelemetry

/**
 * The single door to the Rust OTLP layer on Android, so a process with no JS still reports.
 *
 * ## Why this exists
 *
 * The Rust exporter is dormant until something hands it an endpoint, and until 2026-10-13 only JS
 * did (`configureDevTelemetry` in `location-sharing.ts`). When Android killed the app process the
 * foreground service came back without React, published and pulled through the native runtime,
 * and shipped nothing: on 2026-10-12 a Pixel 10 went dark from 21:11 to 01:26 with its service
 * publishing throughout, and only the next foreground launch's `app.previous_run` said a hole had
 * been there at all. This is the Android twin of `TelemetryConfigurator.swift`.
 *
 * ## The rules it keeps
 *
 * - **At most one configure per (endpoint, instance) per process.** `configure_telemetry` begins
 *   a RECONFIGURE by shutting the previous pipeline down, which blocks on the blocking OTLP client;
 *   with two callers (the service and `init()`) saying the same thing a second apart, that is a
 *   stall bought for nothing. A genuine change still reconfigures.
 * - **Only JS writes the persisted values**, and they carry the build that wrote them. A store
 *   build never configures telemetry, so it never writes them; and a value left on disk by an
 *   earlier build is NOT applied by a later one, because whether this build may ship telemetry is
 *   the later build's decision, which its JS makes again on its first launch.
 */
internal object TelemetryConfigurator {
  private const val TAG = "IrohTelemetry"
  private const val PREFS = "iroh-location.telemetry"
  private const val ENDPOINT_KEY = "endpoint"
  private const val INSTANCE_KEY = "instance_id"
  private const val BUILD_KEY = "build"

  private var applied: Pair<String, String>? = null
  private var lastResult = false

  /**
   * Point the Rust exporter at [endpoint], unless that is already where it points.
   *
   * @param remember persist the values for a later process with no JS. Only the JS call does.
   */
  @Synchronized
  fun apply(context: Context?, endpoint: String, instanceId: String, remember: Boolean): Boolean {
    if (remember && context != null) {
      prefs(context)
        .edit()
        .putString(ENDPOINT_KEY, endpoint)
        .putString(INSTANCE_KEY, instanceId)
        .putLong(BUILD_KEY, buildOf(context))
        .apply()
    }
    val wanted = endpoint to instanceId
    if (applied == wanted) return lastResult
    applied = wanted
    lastResult = configureTelemetry(endpoint, instanceId)
    return lastResult
  }

  /**
   * Re-apply what JS last configured, for a process that may have no JS. A no-op when this build's
   * JS never configured telemetry, and after JS already has in this process.
   *
   * Loads the native library (it is about to be needed anyway), so it is called off the main thread.
   */
  fun applyPersisted(context: Context) {
    val app = context.applicationContext
    val prefs = prefs(app)
    val endpoint = prefs.getString(ENDPOINT_KEY, null)
    if (endpoint.isNullOrEmpty()) return
    if (prefs.getLong(BUILD_KEY, -1L) != buildOf(app)) {
      Log.i(TAG, "persisted telemetry config is from another build; waiting for the app")
      return
    }
    val instanceId = prefs.getString(INSTANCE_KEY, null) ?: "bg"
    try {
      IrohAndroidBootstrap.install(app)
      val active = apply(app, endpoint, instanceId, remember = false)
      Log.i(TAG, "background telemetry: active=$active")
    } catch (e: Throwable) {
      // Telemetry must never be the reason the service cannot publish.
      Log.w(TAG, "background telemetry could not be configured", e)
    }
  }

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun buildOf(context: Context): Long =
    try {
      val info = context.packageManager.getPackageInfo(context.packageName, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode
      } else {
        @Suppress("DEPRECATION") info.versionCode.toLong()
      }
    } catch (e: Exception) {
      -2L
    }
}
