package com.unrealjune.irohlocation

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.wifi.WifiManager
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

// UniFFI-generated bindings for the `iroh-location` crate (in src/main/java/uniffi/…),
// backed by libiroh_location.so under src/main/jniLibs. Regenerate with `just bindgen-android`
// after changing the Rust UniFFI surface (see README §3).
import uniffi.iroh_location.BleCapabilities
import uniffi.iroh_location.BlePeer
import uniffi.iroh_location.BumpResolution
import uniffi.iroh_location.FixListener
import uniffi.iroh_location.IncomingFix
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
import uniffi.iroh_location.Subscription
import uniffi.iroh_location.decodePairInvite
import uniffi.iroh_location.deriveTopic
import uniffi.iroh_location.encodePairInvite

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

private fun bumpResolutionMap(r: BumpResolution): Map<String, Any?> =
  mapOf(
    "status" to r.status,
    "endpointId" to r.endpointId?.toHex(),
    "deviceId" to r.deviceId,
    "rssi" to r.rssi?.toInt(),
    "peerCount" to r.peerCount.toLong(),
    "detail" to r.detail,
  )

class IrohLocationModule : Module() {
  private var node: LocationNode? = null
  private val subs = mutableMapOf<String, Subscription>()
  private var multicastLock: WifiManager.MulticastLock? = null

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
    // catch-up) rather than the live gossip path.
    override fun onFix(author: ByteArray, seq: ULong, fix: LocationFix, backfill: Boolean) {
      sendEvent(
        "onFix",
        mapOf(
          "author" to author.toHex(),
          "seq" to seq.toLong(),
          "fix" to
            mapOf(
              "lat" to fix.lat,
              "lon" to fix.lon,
              "accuracyM" to fix.accuracyM,
              "headingDeg" to fix.headingDeg,
              "ts" to fix.ts.toLong(),
            ),
          "backfill" to backfill,
        ),
      )
    }

    override fun onOpaque(author: ByteArray, seq: ULong) {
      sendEvent("onOpaque", mapOf("author" to author.toHex(), "seq" to seq.toLong()))
    }

    override fun onStatus(status: String) {
      sendEvent("onStatus", mapOf("subscriptionId" to subscriptionId, "status" to status))
    }

    // Durable-trail sync progress for an author/namespace: started | completed | error.
    override fun onSync(author: ByteArray, status: String, recovered: ULong?) {
      val payload =
        mutableMapOf<String, Any>("author" to author.toHex(), "status" to status)
      if (recovered != null) payload["recovered"] = recovered.toLong()
      sendEvent("onSync", payload)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("IrohLocation")
    Events("onFix", "onOpaque", "onStatus", "onSync")

    OnCreate {
      val context =
        appContext.reactContext?.applicationContext
          ?: appContext.currentActivity?.applicationContext
          ?: return@OnCreate
      IrohAndroidBootstrap.install(context)
    }

    AsyncFunction("createNode") Coroutine
      { identityHex: String?, recvHex: String? ->
        clearRuntime()
        val n = LocationNode(identityHex?.hexToBytes(), recvHex?.hexToBytes())
        node = n
        mapOf(
          "endpointId" to n.endpointId().toHex(),
          "identitySecret" to n.identitySecret().toHex(),
          "recvSecret" to n.recvSecret().toHex(),
          "recvPublic" to n.recvPublic().toHex(),
        )
      }

    AsyncFunction("start") Coroutine
      { relayUrls: List<String>, relayAuthToken: String ->
        acquireMulticastLock()
        node?.start(relayUrls, relayAuthToken)
        registerNetworkCallback()
        Unit
      }

    AsyncFunction("shutdown") Coroutine
      { ->
        clearRuntime()
        Unit
      }

    AsyncFunction("ticket") Coroutine { -> node?.ticket() ?: "" }

    Function("deriveTopic") { authorHex: String -> deriveTopic(authorHex.hexToBytes()).toHex() }

    AsyncFunction("subscribe") Coroutine
      { topicHex: String, bootstrap: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        val id = UUID.randomUUID().toString()
        val sub = n.subscribe(topicHex.hexToBytes(), bootstrap, EventBridge(id))
        subs[id] = sub
        id
      }

    AsyncFunction("publish") Coroutine
      {
        subscriptionId: String,
        seq: Double,
        epoch: Double,
        fix: Map<String, Double>,
        recipients: List<String> ->
        val sub = subs[subscriptionId] ?: return@Coroutine
        sub.publish(
          seq.toLong().toULong(),
          epoch.toLong().toUInt(),
          locationFixOf(fix),
          recipients.map { it.hexToBytes() },
        )
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
        epoch: Double,
        fix: Map<String, Double>,
        recipients: List<String> ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.docsWrite(
          subscriptionId,
          seq.toLong().toULong(),
          epoch.toLong().toUInt(),
          locationFixOf(fix),
          recipients.map { it.hexToBytes() },
        )
      }

    AsyncFunction("syncTrail") Coroutine
      { sinceTs: Double, peerTicket: String? ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.syncTrail(sinceTs.toLong().toULong(), peerTicket)
      }

    AsyncFunction("readTrail") Coroutine
      { author: String, sinceTs: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.readTrail(author.hexToBytes(), sinceTs.toLong().toULong()).map { incoming: IncomingFix ->
          mapOf(
            "author" to incoming.author.toHex(),
            "seq" to incoming.seq.toLong(),
            "fix" to
              mapOf(
                "lat" to incoming.fix.lat,
                "lon" to incoming.fix.lon,
                "accuracyM" to incoming.fix.accuracyM,
                "headingDeg" to incoming.fix.headingDeg,
                "ts" to incoming.fix.ts.toLong(),
              ),
          )
        }
      }

    AsyncFunction("pruneTrail") Coroutine
      { olderThanTs: Double ->
        val n = node ?: throw IllegalStateException("call createNode first")
        n.pruneTrail(olderThanTs.toLong().toULong())
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

    // ── BLE status (honest stub off-device) — ARCHITECTURE.md §2 ───────────────────────────

    AsyncFunction("bleAvailable") Coroutine
      { -> node?.bleAvailable() ?: false }

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
}
