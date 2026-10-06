package com.unrealjune.irohlocation

import android.content.Context
import java.io.File
import uniffi.iroh_location.NodeHost
import uniffi.iroh_location.nodeHost

/**
 * Where the node lives, and who owns it — one answer for the module and the background runtime.
 *
 * Both used to spell the roots out themselves. They now have to agree exactly: `NodeHost` adopts a
 * live node only when the roots match, and treats different roots as a different device's storage
 * to be replaced. Two copies of a path are how that would start happening by accident.
 */
internal object NodeStorage {
  /**
   * The trail replica. Big, re-fetchable, and never in Auto Backup (FORWARD-SECRECY.md §4.2).
   */
  fun dataRoot(context: Context): String =
    File(context.applicationContext.cacheDir, "streetcryptid").absolutePath

  /**
   * Ratchet session state. Survives the cache being cleared under storage pressure, which
   * `cacheDir` explicitly does not, and is excluded from backup and device-to-device transfer by
   * `withBackupExclusion.js`. Restoring old session state would rewind send counters, which is key
   * reuse, so both halves are required.
   */
  fun stateRoot(context: Context): String =
    File(context.applicationContext.filesDir, "streetcryptid").absolutePath

  /**
   * The process's node host (Rust `host.rs`): the only thing that builds a node.
   *
   * Lazy because it needs the native library, which [IrohAndroidBootstrap.install] loads; every
   * caller installs before its first touch.
   */
  val host: NodeHost by lazy { nodeHost() }
}
