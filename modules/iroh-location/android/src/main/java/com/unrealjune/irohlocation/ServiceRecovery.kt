package com.unrealjune.irohlocation

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.util.Log

/**
 * Bringing [BackgroundLocationService] back after Android takes it away, and saying so when it can't.
 *
 * ## The failure this exists for
 * On 2026-10-21 a Pixel 10's process reached 3.5 GB and the low-memory killer took it at 15:20:59
 * UTC. `START_REDELIVER_INTENT` did what it promises: three minutes later Android re-created the
 * service. But the app was in the background, so the `startForeground` in `onCreate` threw
 * `ForegroundServiceStartNotAllowedException`, the process crashed, and Android answered the crash
 * with `restartDelay=+218d`. Sharing stayed off for 8.5 hours, until the user opened the app, and
 * because the crash happened before telemetry was configured nothing reached the collector. The
 * same sequence explains every multi-hour Android gap that week.
 *
 * So a redelivered restart is NOT a recovery mechanism on Android 12+, only a chance at one. What
 * this adds:
 *
 * - **No crash.** The service catches the refusal, records it here, and stops itself cleanly, so
 *   there is no crash backoff to wait out.
 * - **A watchdog alarm** while sharing is on. When it fires and the service is gone, it tries the
 *   start again. An exact alarm (`SCHEDULE_EXACT_ALARM` granted) and a battery-optimisation
 *   exemption are the two everyday states in which Android allows a foreground service to start
 *   from the background, so on a phone in either state the start succeeds and the gap is one
 *   watchdog interval. Without them the alarm is inexact and the start may still be refused.
 * - **A "tap to resume" notification** when it is refused. An activity launch is always allowed to
 *   start the service, and the user learning that sharing stopped beats friends finding out from a
 *   frozen dot.
 * - **A durable record** of each refusal, reported as a `location.runtime` event by the next start
 *   that succeeds — the refusal itself happens in a process that may not live long enough to export.
 */
internal object ServiceRecovery {
  private const val TAG = "IrohSvcRecovery"
  private const val PREFS = "iroh-location.service-recovery"
  private const val WANTED_KEY = "sharing_wanted"
  private const val BLOCKED_COUNT_KEY = "blocked_count"
  private const val BLOCKED_FIRST_AT_KEY = "blocked_first_at_ms"
  private const val BLOCKED_REASON_KEY = "blocked_reason"

  /** How often the watchdog checks on the service. Doze stretches it; that is fine. */
  private const val WATCHDOG_INTERVAL_MS = 15 * 60 * 1000L

  private const val RESUME_CHANNEL_ID = "streetcryptid.location-sharing-stopped"
  private const val RESUME_NOTIFICATION_ID = 0x5C11
  private const val ALARM_REQUEST_CODE = 0x5C12

  /** A refusal not yet reported: how many since the last good start, the first one's time, and why. */
  data class Blocked(val count: Int, val firstAtMs: Long, val reason: String)

  private fun prefs(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /**
   * Whether the user has sharing on. Only the explicit start/stop calls set it, so the watchdog and
   * the boot receiver never resurrect a service the user turned off.
   */
  fun isWanted(context: Context): Boolean = prefs(context).getBoolean(WANTED_KEY, false)

  fun setWanted(context: Context, wanted: Boolean) {
    prefs(context).edit().putBoolean(WANTED_KEY, wanted).apply()
    if (wanted) {
      armWatchdog(context)
    } else {
      disarmWatchdog(context)
      clearResumeNotification(context)
    }
  }

  /** Android refused a foreground start. Remember it, then make sure someone will try again. */
  fun recordBlocked(context: Context, reason: String) {
    val p = prefs(context)
    val count = p.getInt(BLOCKED_COUNT_KEY, 0)
    p.edit()
      .putInt(BLOCKED_COUNT_KEY, count + 1)
      .putLong(
        BLOCKED_FIRST_AT_KEY,
        if (count == 0) System.currentTimeMillis() else p.getLong(BLOCKED_FIRST_AT_KEY, 0L),
      )
      .putString(BLOCKED_REASON_KEY, reason)
      // `commit`, not `apply`: this is written by a service that is about to stop, in a process
      // that may be reclaimed moments later — exactly when an async write is lost.
      .commit()
    Log.w(TAG, "foreground start refused ($reason); refusals since last good start: ${count + 1}")
    if (isWanted(context)) {
      armWatchdog(context)
      postResumeNotification(context)
    }
  }

  /** The unreported refusals, cleared as they are read. Called by a start that succeeded. */
  fun takeBlocked(context: Context): Blocked? {
    val p = prefs(context)
    val count = p.getInt(BLOCKED_COUNT_KEY, 0)
    if (count == 0) return null
    val blocked =
      Blocked(
        count = count,
        firstAtMs = p.getLong(BLOCKED_FIRST_AT_KEY, 0L),
        reason = p.getString(BLOCKED_REASON_KEY, null) ?: "unknown",
      )
    p.edit()
      .remove(BLOCKED_COUNT_KEY)
      .remove(BLOCKED_FIRST_AT_KEY)
      .remove(BLOCKED_REASON_KEY)
      .apply()
    return blocked
  }

  /** The service is up: the user no longer needs to be asked to resume it. */
  fun noteStarted(context: Context) {
    clearResumeNotification(context)
  }

  /**
   * Start the service from a context with no foreground (the watchdog, boot), without crashing.
   * Returns whether the start was accepted.
   */
  fun tryStart(context: Context, trigger: String): Boolean =
    try {
      context.startForegroundService(Intent(context, BackgroundLocationService::class.java))
      true
    } catch (e: Exception) {
      // ForegroundServiceStartNotAllowedException (API 31+) is an IllegalStateException; a revoked
      // location permission surfaces as a SecurityException. Either way: not now.
      recordBlocked(context, "$trigger: ${e.javaClass.simpleName}")
      false
    }

  // Battery-optimisation exemption.

  /**
   * Whether the app is exempt from battery optimisation ("Unrestricted"). An exempt app may start
   * its foreground service from the background at any time, which makes every recovery path above
   * succeed without the user's help — the one setting that fully closes the 2026-10-21 failure.
   */
  fun isBatteryOptimizationExempt(context: Context): Boolean =
    context.getSystemService(android.os.PowerManager::class.java)
      ?.isIgnoringBatteryOptimizations(context.packageName) ?: false

  /**
   * Ask for the exemption with the system's one-tap dialog, falling back to the settings list when
   * a vendor build has no handler for the direct request. Returns whether anything was shown.
   */
  fun requestBatteryOptimizationExemption(context: Context): Boolean {
    if (isBatteryOptimizationExempt(context)) return false
    val direct =
      Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        .setData(android.net.Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val list =
      Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    for (intent in listOf(direct, list)) {
      try {
        context.startActivity(intent)
        return true
      } catch (e: Exception) {
        Log.w(TAG, "battery exemption request not shown: ${intent.action}", e)
      }
    }
    return false
  }

  // Watchdog.

  private fun alarmIntent(context: Context): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      ALARM_REQUEST_CODE,
      Intent(context, ServiceRecoveryReceiver::class.java).setAction(ServiceRecoveryReceiver.ACTION_WATCHDOG),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun armWatchdog(context: Context) {
    val alarms = context.getSystemService(AlarmManager::class.java) ?: return
    val at = SystemClock.elapsedRealtime() + WATCHDOG_INTERVAL_MS
    val exact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarms.canScheduleExactAlarms()
    try {
      if (exact) {
        alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(context))
      } else {
        alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(context))
      }
    } catch (e: SecurityException) {
      // The exact-alarm grant was revoked between the check and the call.
      alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, alarmIntent(context))
    }
  }

  private fun disarmWatchdog(context: Context) {
    context.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(context))
  }

  // Resume notification.

  private fun postResumeNotification(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !manager.areNotificationsEnabled()) {
      return
    }
    val launch =
      context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      }
    manager.createNotificationChannel(
      NotificationChannel(RESUME_CHANNEL_ID, "Location sharing stopped", NotificationManager.IMPORTANCE_DEFAULT)
    )
    val notification =
      Notification.Builder(context, RESUME_CHANNEL_ID)
        .setContentTitle("Location sharing paused")
        .setContentText("Android stopped sharing in the background. Tap to resume.")
        .setSmallIcon(android.R.drawable.ic_menu_mylocation)
        .setAutoCancel(true)
        .apply { launch?.let { setContentIntent(it) } }
        .build()
    try {
      manager.notify(RESUME_NOTIFICATION_ID, notification)
    } catch (e: SecurityException) {
      Log.w(TAG, "resume notification not posted", e)
    }
  }

  private fun clearResumeNotification(context: Context) {
    context.getSystemService(NotificationManager::class.java)?.cancel(RESUME_NOTIFICATION_ID)
  }
}

/** The watchdog alarm, boot, and app-update entry points into [ServiceRecovery]. */
class ServiceRecoveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (!ServiceRecovery.isWanted(context)) return
    // Re-arm first, so a start that throws below cannot end the watchdog chain.
    ServiceRecovery.armWatchdog(context)
    if (BackgroundLocationService.isRunning()) return
    val trigger =
      when (intent.action) {
        Intent.ACTION_BOOT_COMPLETED -> "boot"
        Intent.ACTION_MY_PACKAGE_REPLACED -> "package-replaced"
        else -> "watchdog"
      }
    ServiceRecovery.tryStart(context, trigger)
  }

  companion object {
    const val ACTION_WATCHDOG = "com.unrealjune.irohlocation.SERVICE_WATCHDOG"
  }
}
