package com.unrealjune.irohlocation

import android.Manifest
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import android.os.Build
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.lang.ref.WeakReference
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

// UniFFI-generated bindings for the `iroh-location` crate (in src/main/java/uniffi/…),
// backed by libiroh_location.so under src/main/jniLibs. Regenerate with `just bindgen-android`
// after changing the Rust UniFFI surface (see README §3).
import uniffi.iroh_location.BatteryState
import uniffi.iroh_location.BleCapabilities
import uniffi.iroh_location.BlePeer
import uniffi.iroh_location.BumpResolution
import uniffi.iroh_location.ControlMsg
import uniffi.iroh_location.DeliveryConfig
import uniffi.iroh_location.FixListener
import uniffi.iroh_location.RatchetEvent
import uniffi.iroh_location.LocationFix
import uniffi.iroh_location.LocationNode
import uniffi.iroh_location.PairEvent
import uniffi.iroh_location.PairEventKind
import uniffi.iroh_location.PairInvite
import uniffi.iroh_location.PairResult
import uniffi.iroh_location.PairState
import uniffi.iroh_location.PairStateRecord
import uniffi.iroh_location.ProfileView
import uniffi.iroh_location.SasChallenge
import uniffi.iroh_location.SasRoleKind
import uniffi.iroh_location.IngestOutcome
import uniffi.iroh_location.Subscription
import uniffi.iroh_location.TransportConfig
import uniffi.iroh_location.PeerTransportDiagnostic
import uniffi.iroh_location.TransportAddressDiagnostic
import uniffi.iroh_location.TransportDiagnostics
import uniffi.iroh_location.configureTelemetry
import uniffi.iroh_location.decodeMvtBundle
import uniffi.iroh_location.decodeMvtTile
import uniffi.iroh_location.decodePairInvite
import uniffi.iroh_location.deriveTopic
import uniffi.iroh_location.encodePairInvite
import uniffi.iroh_location.endpointIdFromTicket
import uniffi.iroh_location.flushTelemetry
import uniffi.iroh_location.h3CellsForPolygon

private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

private fun String.hexToBytes(): ByteArray =
  chunked(2).map { it.toInt(16).toByte() }.toByteArray()

private fun locationFixOf(fix: Map<String, Double>): LocationFix =
  LocationFix(
    fix["lat"] ?: 0.0,
    fix["lon"] ?: 0.0,
    fix["accuracyM"] ?: 0.0,
    fix["headingDeg"] ?: 0.0,
    (fix["ts"] ?: 0.0).toLong().toULong(),
    // The CAPTURE direction: `state` / `publishedDeltaS` describe a transmission that has not
    // happened yet, and `DrainEngine::drain` fills them in at seal time.
    state = null,
    publishedDeltaS = null,
  )

/**
 * The JS shape of a decrypted fix, including what the envelope says about itself.
 *
 * Absent stamps are OMITTED rather than mapped to null, so JS sees `undefined` — which reads as
 * "this sender does not tell us", the honest meaning of a fix from a build that predates the
 * fields. A sender that says nothing and a sender we cannot understand must not collapse into one
 * value: the first falls back to age, the second is a bug.
 */
private fun fixToMap(fix: LocationFix): Map<String, Any> = buildMap {
  put("lat", fix.lat)
  put("lon", fix.lon)
  put("accuracyM", fix.accuracyM)
  put("headingDeg", fix.headingDeg)
  put("ts", fix.ts.toLong())
  fix.state?.let { put("state", it.toInt()) }
  fix.publishedDeltaS?.let { put("publishedDeltaS", it.toLong()) }
}

/** Build a control message from the JS object (see `NativeControlMsg`). `nonce` crosses as hex. */
private fun controlMsgOf(msg: Map<String, Any?>): ControlMsg =
  ControlMsg(
    ((msg["v"] as? Number)?.toInt() ?: 1).toUByte(),
    ((msg["kind"] as? Number)?.toInt() ?: 0).toUByte(),
    ((msg["ts"] as? Number)?.toLong() ?: 0L).toULong(),
    ((msg["ttlMs"] as? Number)?.toLong() ?: 0L).toUInt(),
    (msg["nonce"] as? String).orEmpty().hexToBytes(),
  )

/** Render a control message back to the JS shape. */
private fun controlMsgToMap(msg: ControlMsg): Map<String, Any> =
  mapOf(
    "v" to msg.v.toInt(),
    "kind" to msg.kind.toInt(),
    "ts" to msg.ts.toLong(),
    "ttlMs" to msg.ttlMs.toLong(),
    "nonce" to msg.nonce.toHex(),
  )

// ── JS-facing conversions: byte arrays → lowercase hex, U64 → JS number ──────────────────────

private fun profileViewMap(p: ProfileView): Map<String, Any> =
  mapOf(
    "endpointId" to p.endpointId.toHex(),
    "epoch" to p.epoch.toLong(),
    "handle" to p.handle,
    "cryptidName" to p.cryptidName,
    "sigil" to p.sigil,
    "color" to p.color,
    "recvPub" to p.recvPub.toHex(),
    "ts" to p.ts.toLong(),
  )

private fun pairInviteMap(inv: PairInvite): Map<String, Any> =
  mapOf(
    "version" to inv.version.toInt(),
    "inviteId" to inv.inviteId.toHex(),
    "secret" to inv.secret.toHex(),
    "endpointId" to inv.endpointId.toHex(),
    "endpointTicket" to inv.endpointTicket,
    "expiresAtMs" to inv.expiresAtMs.toLong(),
  )

private fun pairInviteFrom(m: Map<String, Any?>): PairInvite =
  PairInvite(
    ((m["version"] as? Number)?.toInt() ?: 0).toUByte(),
    (m["inviteId"] as String).hexToBytes(),
    (m["secret"] as String).hexToBytes(),
    (m["endpointId"] as String).hexToBytes(),
    m["endpointTicket"] as String,
    ((m["expiresAtMs"] as? Number)?.toLong() ?: 0L).toULong(),
  )

private fun pairStateName(s: PairState): String =
  when (s) {
    PairState.HANDSHAKING -> "handshaking"
    PairState.PENDING -> "pending"
    PairState.VERIFYING -> "verifying"
    PairState.LOCAL_ACCEPTED -> "localAccepted"
    PairState.PEER_ACCEPTED -> "peerAccepted"
    PairState.COMPLETE -> "complete"
    PairState.REJECTED -> "rejected"
    PairState.FAILED -> "failed"
  }

private fun pairEventKindName(k: PairEventKind): String =
  when (k) {
    PairEventKind.PENDING_REQUEST -> "pendingRequest"
    PairEventKind.VERIFYING -> "verifying"
    PairEventKind.PEER_RESPONDED -> "peerResponded"
    PairEventKind.READY -> "ready"
    PairEventKind.REJECTED -> "rejected"
    PairEventKind.FAILED -> "failed"
  }

private fun sasRoleName(r: SasRoleKind): String =
  when (r) {
    SasRoleKind.DISPLAYER -> "displayer"
    SasRoleKind.PICKER -> "picker"
  }

private fun sasChallengeMap(c: SasChallenge): Map<String, Any> =
  mapOf(
    "role" to sasRoleName(c.role),
    "targetIndex" to c.targetIndex.toLong(),
    "optionIndices" to c.optionIndices.map { it.toLong() },
    "deadlineMs" to c.deadlineMs.toLong(),
  )

private fun pairingFigureIndex(value: Double): UInt {
  require(value.isFinite() && value % 1.0 == 0.0 && value >= 0.0 && value < 256.0) {
    "pairing figure index must be an integer between 0 and 255"
  }
  return value.toUInt()
}

private fun pairStateRecordMap(r: PairStateRecord): Map<String, Any> =
  mapOf(
    "sessionId" to r.sessionId.toHex(),
    "peerEndpointId" to r.peerEndpointId.toHex(),
    "state" to pairStateName(r.state),
    "localAccepted" to r.localAccepted,
    "peerAccepted" to r.peerAccepted,
    "initiator" to r.initiator,
    "nearby" to r.nearby,
    "sasVerified" to r.sasVerified,
    "localSasConfirmed" to r.localSasConfirmed,
  )

private fun pairEventMap(e: PairEvent): Map<String, Any> =
  mapOf(
    "kind" to pairEventKindName(e.kind),
    "sessionId" to e.sessionId.toHex(),
    "peerEndpointId" to e.peerEndpointId.toHex(),
    "nearby" to e.nearby,
  )

private fun pairResultMap(r: PairResult): Map<String, Any?> =
  mapOf(
    "sessionId" to r.sessionId.toHex(),
    "peerEndpointId" to r.peerEndpointId.toHex(),
    "peerRecvPub" to r.peerRecvPub.toHex(),
    "peerEndpointTicket" to r.peerEndpointTicket,
    "peerProfileTicket" to r.peerProfileTicket,
    "peerTrailTicket" to r.peerTrailTicket,
    "peerProfile" to r.peerProfile?.let { profileViewMap(it) },
  )

private fun bleCapabilitiesMap(c: BleCapabilities): Map<String, Any> =
  mapOf(
    "available" to c.available,
    "activeScanToggle" to c.activeScanToggle,
    "rssi" to c.rssi,
    "discoveryRefresh" to c.discoveryRefresh,
    "pairingReady" to c.pairingReady,
  )

private fun blePeerMap(p: BlePeer): Map<String, Any?> =
  mapOf(
    "deviceId" to p.deviceId,
    "phase" to p.phase,
    "verifiedEndpointId" to p.verifiedEndpointId?.toHex(),
    "endpointHint" to p.endpointHint?.toHex(),
    "consecutiveFailures" to p.consecutiveFailures.toLong(),
    "connectPath" to p.connectPath,
  )

private fun transportAddressDiagnosticMap(
  address: TransportAddressDiagnostic
): Map<String, Any?> =
  mapOf(
    "kind" to address.kind,
    "address" to address.address,
    "active" to address.active,
  )

private fun peerTransportDiagnosticMap(peer: PeerTransportDiagnostic): Map<String, Any> =
  mapOf(
    "endpointId" to peer.endpointId.toHex(),
    "known" to peer.known,
    "addresses" to peer.addresses.map { transportAddressDiagnosticMap(it) },
  )

private fun transportDiagnosticsMap(diagnostics: TransportDiagnostics): Map<String, Any> =
  mapOf(
    "localAddresses" to diagnostics.localAddresses.map { transportAddressDiagnosticMap(it) },
    "peers" to diagnostics.peers.map { peerTransportDiagnosticMap(it) },
  )

private fun bumpResolutionMap(r: BumpResolution): Map<String, Any?> =
  mapOf(
    "status" to r.status,
    "endpointId" to r.endpointId?.toHex(),
    "deviceId" to r.deviceId,
    "rssi" to r.rssi?.toInt(),
    "peerCount" to r.peerCount.toLong(),
    "detail" to r.detail,
  )

/**
 * Unknown reports as FULL, never empty. A critical level is a hard stop in the gate, so a device
 * whose battery we cannot read must not look flat and stop publishing forever.
 */
private fun batteryStateOf(m: Map<String, Any>): BatteryState =
  BatteryState(
    (m["level"] as? Double) ?: 1.0,
    (m["charging"] as? Boolean) ?: false,
    (m["lowPower"] as? Boolean) ?: false,
  )

private fun ingestOutcomeToMap(o: IngestOutcome): Map<String, Any?> =
  mapOf(
    "accepted" to o.accepted,
    "rejection" to o.rejection?.name?.lowercase(),
    "enqueued" to o.enqueued.toLong(),
    "published" to o.published.toLong(),
    "pending" to o.pending.toLong(),
    "slotsSkipped" to o.slotsSkipped.toLong(),
    "overflowDropped" to o.overflowDropped.toLong(),
    "suspended" to o.suspended,
  )

class IrohLocationModule : Module() {
  private var node: LocationNode? = null
  private val subs = mutableMapOf<String, Subscription>()
  private var multicastLock: WifiManager.MulticastLock? = null
  private var secretsStore: KeystoreDeviceSecrets? = null

  /**
   * Ask for `POST_NOTIFICATIONS`, which Android 13+ needs before a foreground service notification
   * is visible.
   *
   * The service runs either way — Android does not refuse to start an FGS over this — so a denial
   * costs transparency, not function. That is exactly why it is worth asking for: the ongoing
   * notification is how a location-sharing app tells someone it is running, and silently having one
   * they cannot see is the wrong side of that trade. Below API 33 the permission does not exist and
   * this is trivially true.
   */
  private suspend fun ensurePostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    val manager = appContext.permissions ?: return false
    return suspendCancellableCoroutine { continuation ->
      manager.askForPermissions(
        { result ->
          val granted =
            result[android.Manifest.permission.POST_NOTIFICATIONS]?.status ==
              PermissionsStatus.GRANTED
          continuation.resumeWith(Result.success(granted))
        },
        android.Manifest.permission.POST_NOTIFICATIONS,
      )
    }
  }

  /** The node, or the same error every other node-dependent export raises. */
  private fun requireNode(): LocationNode =
    node ?: throw IllegalStateException("call createNode first")

  /**
   * The device-identity store, built lazily and cached.
   *
   * Lazily because it touches the Keystore, and eagerly constructing it in the module initialiser
   * would put that on every app start including the ones that never share location.
   */
  private fun deviceSecrets(): KeystoreDeviceSecrets =
    secretsStore
      ?: KeystoreDeviceSecrets(
          appContext.reactContext?.applicationContext
            ?: throw IllegalStateException("no application context for the device-secret store")
        )
        .also { secretsStore = it }

  /**
   * Honest radio/permission report for Bump, independent of whether a node exists.
   *
   * The BLE transport reports one flat "unavailable" for every cause, which is why a phone with
   * Bluetooth switched off used to arm Bump and then fail silently. This separates the two causes
   * the user can actually fix, and prefers the radio switch when both apply: turning Bluetooth on
   * is the step that makes the permission prompt worth showing.
   */
  private fun bluetoothRadioState(): String {
    val context =
      appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return "unknown"
    if (!context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
      return "unsupported"
    }
    val adapter =
      (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        ?: return "unsupported"
    // isEnabled() needs no runtime permission (it is @RequiresNoPermission from Android 12 on, and
    // the legacy BLUETOOTH permission is install-time before that), but a vendor ROM throwing here
    // must not take the whole strip down with it.
    val enabled = runCatching { adapter.isEnabled }.getOrElse { return "unknown" }
    if (!enabled) return "poweredOff"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val granted =
        listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT).all {
          context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }
      if (!granted) return "unauthorized"
    }
    return "poweredOn"
  }

  // Long-lived scope for firing the (suspend) network-change nudge from the ConnectivityManager
  // callback, which is itself synchronous. SupervisorJob so one failed nudge never cancels the rest.
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private var connectivityManager: ConnectivityManager? = null
  private var networkCallback: ConnectivityManager.NetworkCallback? = null

  // Android's SELinux policy denies untrusted apps the netlink route socket + /sys/class/net reads
  // that iroh's netmon uses to auto-detect network changes, so iroh is blind to wifi↔cellular roaming
  // and never re-homes its relay path — cross-network sync silently dies after the device leaves a
  // network. We bridge that here: watch the OS default network and nudge iroh (LocationNode.network-
  // Changed → Endpoint::network_change) on every transition so it rebinds sockets + rechecks the relay.
  // We react to onAvailable/onLost only (the actual roam signals); onCapabilitiesChanged fires far too
  // often (signal strength etc.) and forcing a rebind on each would thrash connectivity. Best-effort:
  // if registration fails the node still works, just without proactive rebind on roam.
  private fun registerNetworkCallback() {
    if (networkCallback != null) return
    val context =
      appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    val callback =
      object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = nudgeNetworkChanged()

        override fun onLost(network: Network) = nudgeNetworkChanged()
      }
    runCatching {
      cm.registerDefaultNetworkCallback(callback)
      connectivityManager = cm
      networkCallback = callback
    }
  }

  private fun unregisterNetworkCallback() {
    val cm = connectivityManager
    val cb = networkCallback
    if (cm != null && cb != null) runCatching { cm.unregisterNetworkCallback(cb) }
    connectivityManager = null
    networkCallback = null
  }

  private fun nudgeNetworkChanged() {
    val n = node ?: return
    scope.launch { runCatching { n.networkChanged() } }
  }

  // mDNS local discovery (the Rust `MdnsAddressLookup`) needs to receive multicast, which Android
  // gates behind a held MulticastLock + the CHANGE_WIFI_MULTICAST_STATE permission. We hold it for
  // the node's lifetime and release it in clearRuntime. Best-effort: if the lock can't be acquired
  // the node still connects over relay/DNS, just without the same-Wi-Fi mDNS fast path.
  private fun acquireMulticastLock() {
    if (multicastLock?.isHeld == true) return
    val context =
      appContext.reactContext?.applicationContext
        ?: appContext.currentActivity?.applicationContext
        ?: return
    val wifi = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
    multicastLock =
      wifi.createMulticastLock("iroh-mdns").apply {
        setReferenceCounted(false)
        runCatching { acquire() }
      }
  }

  private fun releaseMulticastLock() {
    runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
    multicastLock = null
  }

  private suspend fun clearRuntime() {
    subs.values.forEach { it.destroy() }
    subs.clear()
    unregisterNetworkCallback()
    releaseMulticastLock()
    val current = node
    node = null
    if (current != null) {
      try {
        current.shutdown()
      } finally {
        current.destroy()
      }
    }
  }

  // Bridges inbound Rust gossip events to the JS EventEmitter.
  private inner class EventBridge(private val subscriptionId: String) : FixListener {
    // `backfill` is true when the fix arrived via durable range-reconciliation (iroh-docs
    // catch-up) rather than the live gossip path. `via` names the last hop into this device
    // (`relay` | `direct` | `lan` | `ble` | `live` | `docs` | `stash`); `viaPeer` names the
    // device that performed it, which is not necessarily the fix's author.
    override fun onFix(
      author: ByteArray,
      seq: ULong,
      fix: LocationFix,
      backfill: Boolean,
      via: String,
      viaPeer: String?,
    ) {
      sendEvent(
        "onFix",
        mapOf(
          "author" to author.toHex(),
          "seq" to seq.toLong(),
          "fix" to fixToMap(fix),
          "backfill" to backfill,
          "via" to via,
          "viaPeer" to viaPeer,
        ),
      )
    }

    override fun onOpaque(author: ByteArray, seq: ULong) {
      sendEvent(
        "onOpaque",
        mapOf(
          "author" to author.toHex(),
          "seq" to seq.toLong(),
          "kind" to if (author.isEmpty()) "opaque" else "null",
        ),
      )
    }

    override fun onStatus(status: String) {
      sendEvent("onStatus", mapOf("subscriptionId" to subscriptionId, "status" to status))
    }

  }

  override fun definition() = ModuleDefinition {
    Name("IrohLocation")
    // `onNativeFix` is the mounted-app handoff: the foreground service captures, but the store
    // claim is process-wide, so while the app is alive the service cannot own the node and hands
    // the capture here instead. See `IrohLocationModule.handOffCapture`.
    Events("onFix", "onOpaque", "onStatus", "onSync", "onNativeFix")

    OnCreate {
      val context = checkNotNull(
        appContext.reactContext?.applicationContext
          ?: appContext.currentActivity?.applicationContext
      ) {
        "IrohLocation requires an Android application context during module initialization"
      }
      IrohAndroidBootstrap.install(context)
    }

    AsyncFunction("createNode") Coroutine
      { identityHex: String?, recvHex: String? ->
        clearRuntime()
        val context = checkNotNull(
          appContext.reactContext?.applicationContext
            ?: appContext.currentActivity?.applicationContext
        ) { "IrohLocation requires an Android application context to create a node" }
        // Two roots, opposite requirements (FORWARD-SECRECY.md §4.2):
        //   cacheDir — the trail replica. Big, re-fetchable, and never in Auto Backup.
        //   filesDir — ratchet session state. Survives the cache being cleared under storage
        //     pressure, which cacheDir explicitly does not, and is excluded from backup and
        //     device-to-device transfer by withBackupExclusion.js. Restoring old session state
        //     would rewind send counters, which is key reuse, so both halves are required.
        val n = LocationNode.newAtDirs(
          identityHex?.hexToBytes(),
          recvHex?.hexToBytes(),
          File(context.cacheDir, "streetcryptid").absolutePath,
          File(context.filesDir, "streetcryptid").absolutePath,
        )
        node = n
        mapOf(
          "endpointId" to n.endpointId().toHex(),
          "identitySecret" to n.identitySecret().toHex(),
          "recvSecret" to n.recvSecret().toHex(),
          "recvPublic" to n.recvPublic().toHex(),
        )
      }

    AsyncFunction("start") Coroutine
      { relayUrls: List<String>, relayAuthToken: String, relayEnabled: Boolean, ipEnabled: Boolean, bleEnabled: Boolean ->
        if (ipEnabled) acquireMulticastLock()
        node?.start(relayUrls, relayAuthToken, relayEnabled, ipEnabled, bleEnabled)
        registerNetworkCallback()
        Unit
      }

    AsyncFunction("shutdown") Coroutine
      { ->
        clearRuntime()
        Unit
      }

    // Device identity — the background drain path's own copy. See DeviceSecretsStore.kt for why
    // this is our entry rather than a read of expo-secure-store's private envelope format.

    AsyncFunction("saveDeviceSecrets") Coroutine
      { identityHex: String, recvHex: String ->
        deviceSecrets().save(identityHex.hexToBytes(), recvHex.hexToBytes())
        Unit
      }

    Function("deviceSecretsProvisioned") { deviceSecrets().isProvisioned() }

    /// Ask for the notification permission the foreground service's ongoing notification needs.
    /// Resolves to whether it is granted; the caller starts the service regardless, because a
    /// denial costs visibility rather than function.
    AsyncFunction("ensureNotificationPermission") Coroutine { -> ensurePostNotifications() }

    /// Remember the transport settings, so the background service can `start` without JS.
    AsyncFunction("setTransportConfig") Coroutine
      { relayUrls: List<String>,
        relayAuthToken: String,
        relayEnabled: Boolean,
        ipEnabled: Boolean,
        bleEnabled: Boolean ->
        requireNode()
          .setTransportConfig(
            TransportConfig(relayUrls, relayAuthToken, relayEnabled, ipEnabled, bleEnabled)
          )
        Unit
      }

    /// Hand one captured fix to the native pipeline on the CURRENT subscription. The background
    /// service does not come through here — it owns its own node — but the mounted app uses it to
    /// exercise the same path the background one takes.
    AsyncFunction("ingestFix") Coroutine
      { subscriptionId: String, fix: Map<String, Double>, battery: Map<String, Any>, intervalMs: Double ->
        val sub = subs[subscriptionId] ?: throw IllegalStateException("no such subscription")
        val outcome =
          sub.ingestFix(
            subscriptionId,
            locationFixOf(fix),
            batteryStateOf(battery),
            intervalMs.coerceAtLeast(1.0).toULong(),
            System.currentTimeMillis().toULong(),
          )
        ingestOutcomeToMap(outcome)
      }

    /// Publish the slots that have come due without a new fix, reusing the last known position.
    /// Driven on a timer by the mounted app — neither platform gives a background process a
    /// reliable one, and the cadence has to stay uniform whether or not the phone is moving.
    AsyncFunction("heartbeatFix") Coroutine
      { subscriptionId: String, battery: Map<String, Any>, intervalMs: Double ->
        val sub = subs[subscriptionId] ?: throw IllegalStateException("no such subscription")
        ingestOutcomeToMap(
          sub.heartbeatFix(
            subscriptionId,
            batteryStateOf(battery),
            intervalMs.coerceAtLeast(1.0).toULong(),
            System.currentTimeMillis().toULong(),
          )
        )
      }

    /// Start/stop the native foreground service. The app calls these when the user turns sharing
    /// on and off; nothing else should, because a service the user did not ask for is a persistent
    /// notification they cannot explain.
    Function("startNativeBackground") {
      // Take the handoff BEFORE starting the service, or the first captures of a mounted session
      // are sent to nobody — and on a fresh install those are the only captures there are.
      sink = WeakReference(this@IrohLocationModule)
      BackgroundLocationService.start(
        checkNotNull(appContext.reactContext?.applicationContext) {
          "IrohLocation needs an application context to start the background service"
        }
      )
    }

    /// Re-program the background runtime from the sampling policy's decision. The accuracy tier is
    /// ignored on Android: `LocationManager` takes providers and a distance filter, not a tier, and
    /// we already request both providers.
    Function("setBackgroundCadence") { intervalMs: Double, distanceM: Double, _accuracy: String ->
      BackgroundLocationService.setCadence(
        checkNotNull(appContext.reactContext?.applicationContext) {
          "IrohLocation needs an application context to re-program the background service"
        },
        intervalMs.toLong(),
        distanceM.toFloat(),
      )
    }

    /// Whether the background runtime is the one currently receiving locations.
    Function("nativeBackgroundRunning") { BackgroundLocationService.isRunning() }

    Function("stopNativeBackground") {
      sink = null
      BackgroundLocationService.stop(
        checkNotNull(appContext.reactContext?.applicationContext) {
          "IrohLocation needs an application context to stop the background service"
        }
      )
    }

    /// This JS runtime is going away, but sharing is NOT off. Drop the handoff, keep the service.
    ///
    /// The counterpart to `stopNativeBackground`, and the service is exactly what must survive: it
    /// is the thing that keeps capturing once there is no JS context to capture into, and stopping
    /// it on a process teardown would take the foreground notification down with it and leave the
    /// phone with nothing running at all until the app is opened again.
    Function("releaseNativeBackground") {
      sink = null
    }

    // Native publish state.

    AsyncFunction("nextSeq") Coroutine
      { -> requireNode().nextSeq().toDouble() }

    AsyncFunction("currentSeq") Coroutine
      { -> requireNode().currentSeq().toDouble() }

    AsyncFunction("seedSeq") Coroutine
      { floor: Double -> requireNode().seedSeq(floor.coerceAtLeast(0.0).toULong()) }

    AsyncFunction("setSharingRecipients") Coroutine
      { recipientEndpointsHex: List<String>, watcherEndpointsHex: List<String> ->
        requireNode().setSharingRecipients(recipientEndpointsHex, watcherEndpointsHex)
        Unit
      }

    /// Read the durable sharing set back. `device.health` reports its size next to the pool's, so a
    /// phone whose JS pool and native list have diverged says so instead of reading healthy.
    AsyncFunction("sharingRecipients") Coroutine
      { -> requireNode().sharingRecipients() }

    /// Record where a drained envelope must be SENT to leave the device. The companion to
    /// `setSharingRecipients`: that one says who to seal for, this one says who to hand the sealed
    /// bytes to. Without it the drain publishes into a local replica nothing reconciles with.
    AsyncFunction("setDeliveryConfig") Coroutine
      { peerTickets: List<String>, stashBaseUrl: String?, stashPsk: String? ->
        requireNode().setDeliveryConfig(DeliveryConfig(peerTickets, stashBaseUrl, stashPsk))
        Unit
      }

    /// When the native drain last accepted, published and pushed. `device.health` reports these as
    /// ages; the JS watermark row only ever saw the JS publish path, which the drain replaced.
    AsyncFunction("publishWatermarks") Coroutine
      { ->
        val w = requireNode().publishWatermarks()
        mapOf(
          "lastAcceptedAt" to w.lastAcceptedAt?.toLong(),
          "lastPublishedAt" to w.lastPublishedAt?.toLong(),
          "lastPushedAt" to w.lastPushedAt?.toLong(),
        )
      }

    AsyncFunction("outboxPending") Coroutine
      { -> requireNode().outboxPending().toDouble() }

    AsyncFunction("clearOutbox") Coroutine
      { ->
        requireNode().clearOutbox()
        Unit
      }

    AsyncFunction("ticket") Coroutine { -> node?.ticket() ?: "" }

    Function("deriveTopic") { authorHex: String -> deriveTopic(authorHex.hexToBytes()).toHex() }

    // Map tile decode (see rust/src/mvt.rs). AsyncFunction bodies run off the JS
    // thread, so decoding a bundle never blocks Hermes. Bytes cross as Uint8Array.
    AsyncFunction("decodeMvtBundle") { bundle: ByteArray -> decodeMvtBundle(bundle) }

    AsyncFunction("decodeMvtTile") { bytes: ByteArray, z: Int, x: Int, y: Int ->
      decodeMvtTile(bytes, z.toUInt(), x.toUInt(), y.toUInt())
    }

    AsyncFunction("h3CellsForPolygon") { coordinates: List<Double>, resolution: Int ->
      h3CellsForPolygon(coordinates, resolution.toUByte())
    }

    AsyncFunction("subscribe") Coroutine
      { topicHex: String, bootstrap: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        val id = UUID.randomUUID().toString()
        val sub = n.subscribe(topicHex.hexToBytes(), bootstrap, EventBridge(id))
        subs[id] = sub
        id
      }

    // Recipients are **endpoint ids**, not receiving keys: every fix lane is envelope v3 now, and
    // a v3 wrap is keyed by the per-friend ratchet session, which is keyed by endpoint id
    // (FORWARD-SECRECY.md §4.7). Returns the recipients left out, as "<endpointHex>:<reason>" —
    // a friend with no session yet, a lapsed one, or one whose state could not be read. The
    // caller must surface these rather than treat a short wrap list as success.
    AsyncFunction("publish") Coroutine
      {
        subscriptionId: String,
        seq: Double,
        fix: Map<String, Double>,
        recipientEndpoints: List<String>,
        traceparent: String? ->
        val sub = subs[subscriptionId] ?: return@Coroutine emptyList<String>()
        if (traceparent != null) {
          sub.publishTraced(
            seq.toLong().toULong(),
            locationFixOf(fix),
            recipientEndpoints,
            traceparent,
          )
        } else {
          sub.publish(
            seq.toLong().toULong(),
            locationFixOf(fix),
            recipientEndpoints,
          )
        }
      }

    // A null fix is an ordinary envelope with an empty padded payload
    // (FORWARD-SECRECY.md §4.1) — the watcher half of the symmetric lanes. No fix map: there is
    // no position, only the tick's timestamp, which rides in the signed header as usual.
    AsyncFunction("publishNull") Coroutine
      {
        subscriptionId: String,
        seq: Double,
        ts: Double,
        watcherEndpoints: List<String>,
        traceparent: String? ->
        val sub = subs[subscriptionId] ?: return@Coroutine emptyList<String>()
        if (traceparent != null) {
          sub.publishNullTraced(
            seq.toLong().toULong(),
            ts.toLong().toULong(),
            watcherEndpoints,
            traceparent,
          )
        } else {
          sub.publishNull(
            seq.toLong().toULong(),
            ts.toLong().toULong(),
            watcherEndpoints,
          )
        }
      }

    AsyncFunction("unsubscribe") { subscriptionId: String ->
      subs.remove(subscriptionId)?.destroy()
      Unit
    }

    // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6 ──────────────────

    AsyncFunction("docsWrite") Coroutine
      {
        subscriptionId: String,
        seq: Double,
        fix: Map<String, Double>,
        recipientEndpoints: List<String>,
        traceparent: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        if (traceparent != null) {
          n.docsWriteRatchetedTraced(
            subscriptionId,
            seq.toLong().toULong(),
            locationFixOf(fix),
            recipientEndpoints,
            traceparent,
          )
        } else {
          n.docsWriteRatcheted(
            subscriptionId,
            seq.toLong().toULong(),
            locationFixOf(fix),
            recipientEndpoints,
          )
        }
      }

    AsyncFunction("docsWriteNull") Coroutine
      {
        subscriptionId: String,
        seq: Double,
        ts: Double,
        watcherEndpoints: List<String>,
        traceparent: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        if (traceparent != null) {
          n.docsWriteNullRatchetedTraced(
            subscriptionId,
            seq.toLong().toULong(),
            ts.toLong().toULong(),
            watcherEndpoints,
            traceparent,
          )
        } else {
          n.docsWriteNullRatcheted(
            subscriptionId,
            seq.toLong().toULong(),
            ts.toLong().toULong(),
            watcherEndpoints,
          )
        }
      }

    // ── ratchet sessions + §4.6 recovery ────────────────────────────────────────────────
    //
    // There is deliberately no `beginSession`/`completeSession` here. A session is bootstrapped
    // by the SAS bump itself (pairing.rs), from ephemerals that are signed, connection-pinned and
    // folded into the figure the two humans compared — so there is no JS-callable seam that could
    // root a session from anything weaker. What JS drives is only recovery.

    /// Whether this peer needs §4.6 recovery: a run of unopenable envelopes, or state we cannot
    /// read at all. Drives the "re-pair" prompt together with `resyncCount`.
    AsyncFunction("isDesynced") Coroutine
      { peerEndpoint: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.isDesynced(peerEndpoint)
      }

    /// How many resyncs we have driven with this peer. Recovery that keeps recovering is not
    /// recovering: past a small number the honest move is to send the humans back to a bump.
    AsyncFunction("resyncCount") Coroutine
      { peerEndpoint: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.resyncCount(peerEndpoint).toLong()
      }

    /// Publish our half of a resync exchange to `recipientRecvPubs`. HPKE-sealed, necessarily:
    /// this is the message that re-establishes a ratchet, so it cannot depend on one.
    AsyncFunction("publishResync") Coroutine
      { recipientRecvPubs: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.publishResync(recipientRecvPubs)
      }

    /// Look for this peer's resync record and restart the session from it, publishing our own
    /// half first if we have not. Returns whether a session was installed; `false` covers "no
    /// record yet", "stale", and "already applied", none of which are errors.
    AsyncFunction("pollResync") Coroutine
      { peerEndpoint: String, peerRecvPub: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pollResync(peerEndpoint, peerRecvPub)
      }

    /// Drop our in-flight resync ephemeral once every peer has been restarted.
    AsyncFunction("clearResync") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.clearResync()
      }

    /// Forget this peer's session entirely — unfriend or revoke.
    AsyncFunction("forgetSession") Coroutine
      { peerEndpoint: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.forgetSession(peerEndpoint)
      }

    AsyncFunction("syncLatest") Coroutine
      { peerTickets: List<String>, traceparent: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.syncLatest(peerTickets, traceparent)
      }

    AsyncFunction("pushTrail") Coroutine
      { peerTickets: List<String>, traceparent: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pushTrail(peerTickets, traceparent)
      }

    AsyncFunction("uploadTrailContent") Coroutine
      { baseUrl: String, psk: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.uploadTrailContent(baseUrl, psk).toDouble()
      }

    // Live-mode request channel (ARCHITECTURE §9c). Writes OUR single control slot, superseding
    // any previous message from us; needs a `pushTrail` afterwards like any other docs write.
    AsyncFunction("docsWriteControl") Coroutine
      { msg: Map<String, Any?>, recipients: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.docsWriteControl(controlMsgOf(msg), recipients.map { it.hexToBytes() })
      }

    AsyncFunction("readControl") Coroutine
      { author: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.readControl(author.hexToBytes()).map { controlMsgToMap(it) }
      }

    AsyncFunction("readLatest") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.readLatestRatchetedEvents().map { incoming: RatchetEvent ->
          mapOf(
            "author" to incoming.author.toHex(),
            "seq" to incoming.seq.toLong(),
            "ts" to incoming.ts.toLong(),
            "kind" to incoming.kind,
            "fix" to incoming.fix?.let { fixToMap(it) },
            "viaPeer" to incoming.viaPeer,
          )
        }
      }

    AsyncFunction("pruneTrail") Coroutine
      { olderThanTs: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pruneTrail(olderThanTs.toLong().toULong())
      }

    // Developer telemetry (crate-level, not node-scoped — callable before createNode). Returns
    // false when the Rust binary was built without the `otel` feature, so JS treats "disabled"
    // and "unavailable" alike.
    AsyncFunction("configureTelemetry") Coroutine
      { endpoint: String, instanceId: String ->
        configureTelemetry(endpoint, instanceId)
      }

    AsyncFunction("flushTelemetry") Coroutine
      { ->
        flushTelemetry()
      }

    AsyncFunction("docTicket") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.docTicket()
      }

    AsyncFunction("importDocTicket") Coroutine
      { ticket: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.importDocTicket(ticket)
      }

    // ── Profiles — see docs/social/ARCHITECTURE.md §3 ─────────────────────────────────────

    AsyncFunction("publishProfile") Coroutine
      { handle: String, cryptidName: String, sigil: String, color: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.publishProfile(handle, cryptidName, sigil, color).toLong()
      }

    AsyncFunction("profileTicket") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.profileTicket()
      }

    AsyncFunction("importProfileTicket") Coroutine
      { ticket: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.importProfileTicket(ticket)
      }

    AsyncFunction("readProfile") Coroutine
      { endpointIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.readProfile(endpointIdHex.hexToBytes())?.let { profileViewMap(it) }
      }

    AsyncFunction("pollProfileEvents") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pollProfileEvents().map { profileViewMap(it) }
      }

    // ── Bilateral pairing (`streetcryptid/pair/2`) — ARCHITECTURE.md §4 ─────────────────────

    AsyncFunction("setPairingReady") Coroutine
      { ready: Boolean ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.setPairingReady(ready)
      }

    AsyncFunction("pairingReady") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pairingReady()
      }

    AsyncFunction("createPairInvite") Coroutine
      { ttlSecs: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        val inv = n.createInvite(ttlSecs.toLong().toULong())
        pairInviteMap(inv) + ("token" to encodePairInvite(inv))
      }

    AsyncFunction("initiatePair") Coroutine
      { invite: Map<String, Any> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.initiatePair(pairInviteFrom(invite)).toHex()
      }

    AsyncFunction("initiatePairByToken") Coroutine
      { token: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.initiatePairByTicket(token).toHex()
      }

    AsyncFunction("initiatePairNearby") Coroutine
      { peerEndpointIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.initiatePairNearby(peerEndpointIdHex.hexToBytes()).toHex()
      }

    AsyncFunction("respondPair") Coroutine
      { sessionIdHex: String, accept: Boolean ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.respondPair(sessionIdHex.hexToBytes(), accept)
      }

    AsyncFunction("pairSasChallenge") Coroutine
      { sessionIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pairSasChallenge(sessionIdHex.hexToBytes())?.let { sasChallengeMap(it) }
      }

    AsyncFunction("submitPairChoice") Coroutine
      { sessionIdHex: String, chosenIndex: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.submitPairChoice(sessionIdHex.hexToBytes(), pairingFigureIndex(chosenIndex))
      }

    AsyncFunction("confirmPairDisplay") Coroutine
      { sessionIdHex: String, matched: Boolean ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.confirmPairDisplay(sessionIdHex.hexToBytes(), matched)
      }

    AsyncFunction("cancelPair") Coroutine
      { sessionIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.cancelPair(sessionIdHex.hexToBytes())
      }

    AsyncFunction("pollPairEvents") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pollPairEvents().map { pairEventMap(it) }
      }

    AsyncFunction("pairState") Coroutine
      { sessionIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pairState(sessionIdHex.hexToBytes())?.let { pairStateRecordMap(it) }
      }

    AsyncFunction("listPairSessions") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.listPairSessions().map { pairStateRecordMap(it) }
      }

    AsyncFunction("pairResult") Coroutine
      { sessionIdHex: String ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pairResult(sessionIdHex.hexToBytes())?.let { pairResultMap(it) }
      }

    AsyncFunction("encodePairInvite") Coroutine
      { invite: Map<String, Any> -> encodePairInvite(pairInviteFrom(invite)) }

    AsyncFunction("decodePairInvite") Coroutine
      { token: String -> pairInviteMap(decodePairInvite(token)) }

    // Pure decode, node-free: lets JS recognise a configured stash by its EndpointId.
    AsyncFunction("endpointIdFromTicket") Coroutine { ticket: String -> endpointIdFromTicket(ticket) }

    AsyncFunction("transportDiagnostics") Coroutine
      { peerEndpointIdsHex: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        transportDiagnosticsMap(n.transportDiagnostics(peerEndpointIdsHex.map { it.hexToBytes() }))
      }

    // What this replica can SERVE, per author — presence, never payload.
    AsyncFunction("trailReplicaStatus") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.trailReplicaStatus().map { slot ->
          mapOf(
            "author" to slot.author.toHex(),
            "seq" to slot.seq.toLong(),
            "fixTs" to slot.fixTs.toLong(),
            "hasContent" to slot.hasContent,
          )
        }
      }

    // ── BLE status (honest stub off-device) — ARCHITECTURE.md §2 ───────────────────────────

    AsyncFunction("bleAvailable") Coroutine
      { -> node?.bleAvailable() ?: false }

    AsyncFunction("bluetoothRadioState") { -> bluetoothRadioState() }

    AsyncFunction("bleCapabilities") Coroutine
      { ->
        val n = node ?: throw IllegalStateException("call createNode first")
        bleCapabilitiesMap(n.bleCapabilities())
      }

    AsyncFunction("nearbyBlePeers") Coroutine
      { -> node?.nearbyBlePeers()?.map { blePeerMap(it) } ?: emptyList() }

    AsyncFunction("resolveBumpPeer") Coroutine
      { timeoutMs: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        bumpResolutionMap(n.resolveBumpPeer(timeoutMs.toLong().toULong()))
      }

    AsyncFunction("bleHasScanHint") Coroutine
      { endpointIdHex: String -> node?.bleHasScanHint(endpointIdHex.hexToBytes()) ?: false }
  }

  companion object {
    /**
     * Where the foreground service sends a capture it could not publish itself.
     *
     * The store claim in `durable.rs` is **process-wide**, and the service runs in the app process
     * using the same storage roots. So whenever the app is alive it has already claimed the stores
     * and `NativeBackgroundRuntime.ensureStarted` returns false there — always, not occasionally.
     * That was survivable while a JS `watchPositionAsync` covered the mounted case; once capture
     * moved into Rust and that watcher was deleted, it meant an app that was merely *running* —
     * foreground or backgrounded with the service up — captured fixes and dropped every one. A
     * Pixel spent 2026-08-31 in that state: service healthy, `location_running=true`, permissions
     * granted, and `last_fix_age_ms` climbing past fifteen hours.
     *
     * Handing the fix to JS is not a fallback path, it is the mounted path. The mounted runtime
     * owns the node, so it is the only thing that *can* publish; the service is the sensor. This is
     * the Android counterpart of `BackgroundLocationRuntime.eventSink` on iOS, and it emits the
     * same `onNativeFix` payload so one JS handler serves both platforms.
     *
     * Weak so a torn-down module cannot be held alive by a service that outlives it; null when
     * sharing is off, which is the one time there is legitimately nobody to tell.
     */
    private var sink: WeakReference<IrohLocationModule>? = null

    /**
     * Hand one capture to the mounted app. Returns whether anything was listening.
     *
     * `false` means the fix is genuinely lost rather than queued, which is worth logging at the
     * call site: it is the signature of the bug this exists to prevent.
     */
    fun handOffCapture(fix: LocationFix, battery: BatteryState, reason: String): Boolean {
      val module = sink?.get() ?: return false
      module.sendEvent(
        "onNativeFix",
        mapOf(
          "kind" to "fix",
          "reason" to reason,
          "state" to "moving",
          "battery" to
            mapOf(
              "level" to battery.level,
              "charging" to battery.charging,
              "lowPower" to battery.lowPower,
            ),
          "fix" to fixToMap(fix),
        ),
      )
      return true
    }
  }
}
