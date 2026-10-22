package com.unrealjune.irohlocation

import android.os.Debug
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.io.File
import uniffi.iroh_location.ProcessMemorySample
import uniffi.iroh_location.recordProcessMemory

/**
 * `process.memory` from the Android process — see `process_memory.rs` for why it exists.
 *
 * Sampled on the location-runtime pulse, so it covers exactly the process that matters: the one
 * running the foreground service, with or without a JS context. Everything here is a cheap read of
 * `/proc/self` or a runtime counter; PSS is skipped because `Debug.getMemoryInfo` walks every
 * mapping and is too heavy for a five-minute timer on a phone that is already short of memory.
 */
internal object ProcessMemorySampler {
  private const val TAG = "IrohProcMemory"

  fun sample(trigger: String) {
    // Nothing loaded the native library: there is no exporter to report to.
    if (!IrohAndroidBootstrap.installed) return
    try {
      val status = readStatus()
      val runtime = Runtime.getRuntime()
      val sample =
        ProcessMemorySample(
          trigger = trigger,
          rssBytes = status["VmRSS"],
          rssAnonBytes = status["RssAnon"],
          rssFileBytes = status["RssFile"],
          swapBytes = status["VmSwap"],
          nativeHeapBytes = Debug.getNativeHeapAllocatedSize().toULong(),
          javaHeapBytes = (runtime.totalMemory() - runtime.freeMemory()).toULong(),
          pssBytes = null,
          threads = status["Threads"]?.toUInt(),
          fds = File("/proc/self/fd").list()?.size?.toUInt(),
          maps = countLines("/proc/self/maps"),
          uptimeMs = (SystemClock.elapsedRealtime() - Process.getStartElapsedRealtime()).toULong(),
          appWired = IrohLocationModule.appIsWired(),
        )
      // One logcat line too, so `adb logcat -s IrohProcMemory` shows the trend without a collector.
      Log.i(
        TAG,
        "$trigger rss=${mb(sample.rssBytes)} anon=${mb(sample.rssAnonBytes)} " +
          "file=${mb(sample.rssFileBytes)} native=${mb(sample.nativeHeapBytes)} " +
          "java=${mb(sample.javaHeapBytes)} threads=${sample.threads} fds=${sample.fds} " +
          "maps=${sample.maps} wired=${sample.appWired}",
      )
      recordProcessMemory(sample)
    } catch (e: Throwable) {
      Log.w(TAG, "process.memory not recorded", e)
    }
  }

  /** The `kB` fields of `/proc/self/status` we use, in bytes; `Threads` as a plain count. */
  private fun readStatus(): Map<String, ULong> {
    val wanted = setOf("VmRSS", "RssAnon", "RssFile", "VmSwap", "Threads")
    val out = HashMap<String, ULong>()
    File("/proc/self/status").forEachLine { line ->
      val key = line.substringBefore(':')
      if (key !in wanted) return@forEachLine
      val value = line.substringAfter(':').trim().substringBefore(' ').toULongOrNull() ?: return@forEachLine
      out[key] = if (key == "Threads") value else value * 1024u
    }
    return out
  }

  private fun countLines(path: String): UInt? =
    try {
      var n = 0u
      File(path).forEachLine { n++ }
      n
    } catch (e: Exception) {
      null
    }

  private fun mb(bytes: ULong?): String = bytes?.let { "${it / 1_048_576u}M" } ?: "?"
}
