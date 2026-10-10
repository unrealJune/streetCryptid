package com.unrealjune.irohlocation

import android.content.Context
import org.jakebot.blew.BleCentralManager
import org.jakebot.blew.BlePeripheralManager
import uniffi.iroh_location.uniffiEnsureInitialized

internal object IrohAndroidBootstrap {
  /** Whether the native library is loaded — and so whether anything can have touched the node. */
  @Volatile
  var installed = false
    private set

  @JvmStatic private external fun initializeNative(context: Context): Int

  @Synchronized
  fun install(context: Context) {
    if (installed) return
    System.loadLibrary("iroh_location")
    check(initializeNative(context.applicationContext) == 0) {
      "Could not install the Android context for iroh"
    }
    BleCentralManager.init(context.applicationContext)
    BlePeripheralManager.init(context.applicationContext)
    uniffiEnsureInitialized()
    installed = true
  }
}
