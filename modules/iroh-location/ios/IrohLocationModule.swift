import ExpoModulesCore
import CoreBluetooth

/// Reads the Bluetooth radio's power/authorization state without touching the iroh node.
///
/// The BLE transport reports one flat "unavailable" for every cause, so Bump used to arm and then
/// fail silently on a phone whose radio was simply switched off. CoreBluetooth only reports state
/// through a delegate callback, so the first read waits briefly for it rather than lying `unknown`.
/// The manager is created with the power alert suppressed — the app decides how to ask.
private final class BluetoothRadioProbe: NSObject, CBCentralManagerDelegate {
  static let shared = BluetoothRadioProbe()

  private let queue = DispatchQueue(label: "com.unrealjune.irohlocation.bluetooth-probe")
  private var manager: CBCentralManager?

  func state() async -> String {
    start()
    // ~1.5s of 50ms polls: the first callback normally lands within one or two.
    for _ in 0..<30 {
      let current = currentState()
      if current != .unknown && current != .resetting { return Self.name(current) }
      try? await Task.sleep(nanoseconds: 50_000_000)
    }
    return Self.name(currentState())
  }

  private func start() {
    queue.sync {
      if manager == nil {
        manager = CBCentralManager(
          delegate: self, queue: queue,
          options: [CBCentralManagerOptionShowPowerAlertKey: false])
      }
    }
  }

  private func currentState() -> CBManagerState {
    queue.sync { manager?.state ?? .unknown }
  }

  private static func name(_ state: CBManagerState) -> String {
    switch state {
    case .poweredOn: return "poweredOn"
    case .poweredOff: return "poweredOff"
    case .unauthorized: return "unauthorized"
    case .unsupported: return "unsupported"
    default: return "unknown"
    }
  }

  // Required by the protocol; the polled `state` property is the whole signal.
  func centralManagerDidUpdateState(_ central: CBCentralManager) {}
}

// The UniFFI-generated Swift bindings for the `iroh-location` Rust crate are compiled
// into this target (see IrohLocation.podspec -> vendored xcframework + generated/*.swift).
// They expose: `LocationNode`, the `ReplicaListener` protocol, the profile / pairing / BLE
// records + enums, and the free functions `generateRecvKeypair()`, `encodePairInvite(invite:)`,
// `decodePairInvite(token:)`, and `endpointIdFromTicket(ticket:)`.
//
// Regenerate with `just bindgen-ios` on macOS (source bindings can also be produced from a
// host library via `uniffi-bindgen ... --language swift`; only the XCFramework needs macOS).

/// Unknown reports as FULL, never empty. A critical level is a hard stop in the gate, so a device
/// whose battery we cannot read must not look flat and stop publishing forever.
private func batteryState(from raw: [String: Any]) -> BatteryState {
  BatteryState(
    level: (raw["level"] as? Double) ?? 1.0,
    charging: (raw["charging"] as? Bool) ?? false,
    lowPower: (raw["lowPower"] as? Bool) ?? false)
}

private func ingestOutcomeToDict(_ outcome: IngestOutcome) -> [String: Any?] {
  [
    "accepted": outcome.accepted,
    "rejection": outcome.rejection.map { String(describing: $0) },
    "enqueued": Double(outcome.enqueued),
    "published": Double(outcome.published),
    "reached": Double(outcome.reached),
    "pending": Double(outcome.pending),
    "slotsSkipped": Double(outcome.slotsSkipped),
    "overflowDropped": Double(outcome.overflowDropped),
    "suspended": outcome.suspended,
  ]
}

private func hexToData(_ hex: String) -> Data {
  var data = Data(capacity: hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    if let byte = UInt8(hex[index..<next], radix: 16) { data.append(byte) }
    index = next
  }
  return data
}

private func dataToHex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

/// The node's two storage roots, which have opposite requirements (FORWARD-SECRECY.md §4.2).
///
/// - `data` → the temp dir. The docs/blobs replica: large, re-fetchable from the stash and from
///   friends, and something the OS is welcome to reclaim. This is byte-for-byte the path the
///   Rust `default_data_dir` used before the roots were split (`temp_dir()/streetcryptid/<id>`),
///   deliberately — moving it would abandon every existing install's replica for no benefit.
/// - `state` → Application Support. Ratchet session state, which is **not** recoverable — losing
///   it desyncs every friend at once, so it cannot live anywhere iOS purges. Application Support
///   *is* backed up by default, and restoring an old copy would rewind send counters into key
///   reuse, so `excludeFromBackup` below is not optional decoration; it is the other half of
///   putting the state here at all.
/// Internal rather than file-private: `BackgroundLocationRuntime` builds a node from the same
/// two roots, and duplicating the rule is how the two halves of it drift apart.
func nodeStorageRoots() -> (data: URL, state: URL) {
  let fm = FileManager.default
  let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
  // Application Support is not guaranteed to exist; createDirectory below makes it.
  let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  return (
    tmp.appendingPathComponent("streetcryptid", isDirectory: true),
    support.appendingPathComponent("streetcryptid", isDirectory: true)
  )
}

/// Create `dir` and stamp `NSURLIsExcludedFromBackupKey` on it.
///
/// The flag is inherited by everything created underneath, so stamping the root covers the
/// per-identity subdirectory the Rust side creates. Best-effort on the *creation* — the node
/// re-creates what it needs on `start()` — but a failure here means the state root may be
/// backed up, so it is logged loudly rather than swallowed.
private func excludeFromBackup(_ dir: URL) {
  var dir = dir
  do {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try dir.setResourceValues(values)
  } catch {
    NSLog("IrohLocation: could not exclude %@ from backup: %@",
          dir.path, error.localizedDescription)
  }
}

/// Build the UniFFI `LocationFix` from the JS bridge dict.
///
/// The envelope stamps are always `nil` here. This is the CAPTURE direction — a position the OS
/// just handed us — and `state` / `publishedDeltaS` describe a transmission that has not happened
/// yet. `DrainEngine::drain` fills them in at seal time.
private func locationFix(from fix: [String: Double]) -> LocationFix {
  LocationFix(
    lat: fix["lat"] ?? 0, lon: fix["lon"] ?? 0, accuracyM: fix["accuracyM"] ?? 0,
    headingDeg: fix["headingDeg"] ?? 0, ts: UInt64(fix["ts"] ?? 0),
    state: nil, publishedDeltaS: nil)
}

/// The JS shape of a decrypted fix, including what the envelope says about itself.
///
/// Absent stamps are OMITTED rather than sent as null, so JS sees `undefined` — which reads as
/// "this sender does not tell us", the honest meaning of a fix from a build that predates the
/// fields. A sender that says nothing and a sender we cannot understand must not collapse into the
/// same value, because the UI's answer differs: one falls back to age, the other is a bug.
private func fixToDict(_ fix: LocationFix) -> [String: Any] {
  var out: [String: Any] = [
    "lat": fix.lat, "lon": fix.lon, "accuracyM": fix.accuracyM,
    "headingDeg": fix.headingDeg, "ts": fix.ts,
  ]
  if let state = fix.state { out["state"] = Int(state) }
  if let delta = fix.publishedDeltaS { out["publishedDeltaS"] = Int(delta) }
  return out
}

// ── JS-facing conversions: byte arrays → lowercase hex, U64 → JS number ──────────────────────

private func profileViewDict(_ p: ProfileView) -> [String: Any] {
  [
    "endpointId": dataToHex(p.endpointId),
    "epoch": p.epoch,
    "handle": p.handle,
    "cryptidName": p.cryptidName,
    "sigil": p.sigil,
    "color": p.color,
    "recvPub": dataToHex(p.recvPub),
    "ts": p.ts,
  ]
}

private func pairInviteDict(_ inv: PairInvite) -> [String: Any] {
  [
    "version": inv.version,
    "inviteId": dataToHex(inv.inviteId),
    "secret": dataToHex(inv.secret),
    "endpointId": dataToHex(inv.endpointId),
    "endpointTicket": inv.endpointTicket,
    "expiresAtMs": inv.expiresAtMs,
  ]
}

private func pairInvite(from m: [String: Any]) -> PairInvite {
  PairInvite(
    version: (m["version"] as? NSNumber)?.uint8Value ?? 0,
    inviteId: hexToData(m["inviteId"] as? String ?? ""),
    secret: hexToData(m["secret"] as? String ?? ""),
    endpointId: hexToData(m["endpointId"] as? String ?? ""),
    endpointTicket: m["endpointTicket"] as? String ?? "",
    expiresAtMs: (m["expiresAtMs"] as? NSNumber)?.uint64Value ?? 0)
}

private func pairStateName(_ s: PairState) -> String {
  switch s {
  case .handshaking: return "handshaking"
  case .pending: return "pending"
  case .verifying: return "verifying"
  case .localAccepted: return "localAccepted"
  case .peerAccepted: return "peerAccepted"
  case .complete: return "complete"
  case .rejected: return "rejected"
  case .failed: return "failed"
  }
}

private func pairEventKindName(_ k: PairEventKind) -> String {
  switch k {
  case .pendingRequest: return "pendingRequest"
  case .verifying: return "verifying"
  case .peerResponded: return "peerResponded"
  case .ready: return "ready"
  case .rejected: return "rejected"
  case .failed: return "failed"
  }
}

private func sasRoleName(_ r: SasRoleKind) -> String {
  switch r {
  case .displayer: return "displayer"
  case .picker: return "picker"
  }
}

private func sasChallengeDict(_ c: SasChallenge) -> [String: Any] {
  [
    "role": sasRoleName(c.role),
    "targetIndex": c.targetIndex,
    "optionIndices": c.optionIndices,
    "deadlineMs": c.deadlineMs,
  ]
}

private func pairingFigureIndex(_ value: Double) throws -> UInt32 {
  guard value.isFinite, value.rounded(.towardZero) == value, value >= 0, value < 256 else {
    throw Exception(
      name: "InvalidPairingFigure",
      description: "pairing figure index must be an integer between 0 and 255")
  }
  return UInt32(value)
}

private func pairStateRecordDict(_ r: PairStateRecord) -> [String: Any] {
  [
    "sessionId": dataToHex(r.sessionId),
    "peerEndpointId": dataToHex(r.peerEndpointId),
    "state": pairStateName(r.state),
    "localAccepted": r.localAccepted,
    "peerAccepted": r.peerAccepted,
    "initiator": r.initiator,
    "nearby": r.nearby,
    "sasVerified": r.sasVerified,
    "localSasConfirmed": r.localSasConfirmed,
  ]
}

private func pairEventDict(_ e: PairEvent) -> [String: Any] {
  [
    "kind": pairEventKindName(e.kind),
    "sessionId": dataToHex(e.sessionId),
    "peerEndpointId": dataToHex(e.peerEndpointId),
    "nearby": e.nearby,
  ]
}

private func pairResultDict(_ r: PairResult) -> [String: Any] {
  [
    "sessionId": dataToHex(r.sessionId),
    "peerEndpointId": dataToHex(r.peerEndpointId),
    "peerRecvPub": dataToHex(r.peerRecvPub),
    "peerEndpointTicket": r.peerEndpointTicket,
    "peerProfileTicket": r.peerProfileTicket,
    "peerTrailTicket": r.peerTrailTicket,
    "peerProfile": r.peerProfile.map { profileViewDict($0) } ?? NSNull(),
  ]
}

private func bleCapabilitiesDict(_ c: BleCapabilities) -> [String: Any] {
  [
    "available": c.available,
    "activeScanToggle": c.activeScanToggle,
    "rssi": c.rssi,
    "discoveryRefresh": c.discoveryRefresh,
    "pairingReady": c.pairingReady,
  ]
}

private func blePeerDict(_ p: BlePeer) -> [String: Any] {
  [
    "deviceId": p.deviceId,
    "phase": p.phase,
    "verifiedEndpointId": p.verifiedEndpointId.map { dataToHex($0) } ?? NSNull(),
    "endpointHint": p.endpointHint.map { dataToHex($0) } ?? NSNull(),
    "consecutiveFailures": p.consecutiveFailures,
    "connectPath": p.connectPath ?? NSNull(),
  ]
}

private func transportAddressDiagnosticDict(_ address: TransportAddressDiagnostic) -> [String: Any] {
  [
    "kind": address.kind,
    "address": address.address,
    "active": address.active.map { $0 as Any } ?? NSNull(),
  ]
}

private func peerTransportDiagnosticDict(_ peer: PeerTransportDiagnostic) -> [String: Any] {
  [
    "endpointId": dataToHex(peer.endpointId),
    "known": peer.known,
    "addresses": peer.addresses.map { transportAddressDiagnosticDict($0) },
  ]
}

private func transportDiagnosticsDict(_ diagnostics: TransportDiagnostics) -> [String: Any] {
  [
    "localAddresses": diagnostics.localAddresses.map { transportAddressDiagnosticDict($0) },
    "peers": diagnostics.peers.map { peerTransportDiagnosticDict($0) },
  ]
}

private func bumpResolutionDict(_ resolution: BumpResolution) -> [String: Any] {
  [
    "status": resolution.status,
    "endpointId": resolution.endpointId.map { dataToHex($0) } ?? NSNull(),
    "deviceId": resolution.deviceId ?? NSNull(),
    "rssi": resolution.rssi.map { Int($0) as Any } ?? NSNull(),
    "peerCount": resolution.peerCount,
    "detail": resolution.detail,
  ]
}

/// Tells JS which friends' replica slots just became readable (`ReplicaListener` in `lib.rs`).
///
/// Carries authors only. The entries themselves stay in the replica and are read back with
/// `readLatest`, so a notification that is dropped (no app mounted, a JS context going away) loses
/// nothing but latency.
private final class ReplicaBridge: ReplicaListener, @unchecked Sendable {
  weak var module: IrohLocationModule?
  init(module: IrohLocationModule) { self.module = module }
  func onFriendEntries(authors: [Data]) {
    module?.sendEvent("onReplicaChanged", ["authors": authors.map(dataToHex)])
  }
}

public final class IrohLocationModule: Module {
  /// Set while JS wants replica notifications. Re-attached to every node generation, because a
  /// restart or replacement builds a new `LocationNode` that knows no listener.
  private var replicaBridge: ReplicaBridge?

  /// App leases THIS module instance holds on the process's node: one per `createNode` not yet
  /// matched by a `shutdown`.
  ///
  /// The node is not this module's. `NodeHost` (Rust, `host.rs`) builds it, hands the SAME one to
  /// every JS context and to `BackgroundLocationRuntime`, and shuts it down when the last lease is
  /// returned. That replaced a per-instance node with a refcount, which let two JS contexts share
  /// a node but left the background runtime building a rival one behind a claim race, an owner
  /// flag and a bounded handover.
  private var leases = 0
  private var cachedNode: LocationNode?
  private var cachedGeneration: UInt64 = .max
  private let nodeLock = NSLock()

  /// The process's node while this module holds a lease, else nil.
  ///
  /// Cached by `NodeHost.generation()`, which moves exactly when the host's answer does (a restart,
  /// a replacement, the last release). A superseded handle is simply dropped; Swift frees it once
  /// the last in-flight call on it returns.
  private var node: LocationNode? {
    nodeLock.lock()
    defer { nodeLock.unlock() }
    guard leases > 0 else { return nil }
    let host = nodeHost()
    let generation = host.generation()
    if generation != cachedGeneration {
      cachedNode = host.current()
      cachedGeneration = generation
      if let bridge = replicaBridge { cachedNode?.watchReplica(listener: bridge) }
    }
    return cachedNode
  }

  /// Undo what this module set up AROUND the node — never the node itself, which is the host's.
  ///
  /// The host detaches the replica listener itself once no app holds the node; this only forgets
  /// that JS asked for one.
  private func clearModuleRuntime() {
    nodeLock.lock()
    replicaBridge = nil
    cachedNode = nil
    cachedGeneration = .max
    nodeLock.unlock()
  }

  /// Bounds a lease release; the JS side bounds its whole teardown again on the outside.
  private static let shutdownBudgetMs: UInt64 = 5_000

  /// Bounds the old node's shutdown inside a restart.
  private static let restartBudgetMs: UInt64 = 5_000

  public func definition() -> ModuleDefinition {
    Name("IrohLocation")
    // `onNativeFix` is the mounted-app handoff: while the app is wired the background runtime hands
    // its captures here rather than running them itself. See `BackgroundLocationRuntime.eventSink`.
    Events("onReplicaChanged", "onNativeFix", "onFriendsPulled")

    /// Whether this binary refcounts the node instead of clobbering it on a second `createNode`.
    ///
    /// A capability probe rather than a version check, because a phone can be running an older
    /// binary than the JS bundle. JS uses it to decide whether the pre-`createNode` idle wait is
    /// still needed; see `awaitRuntimeIdleBounded` in `location-sharing.ts`.
    AsyncFunction("nativeRuntimeAdoptsNode") { () -> Bool in
      true
    }

    AsyncFunction("createNode") { (identityHex: String?, recvHex: String?) async throws -> [String: String] in
      let roots = nodeStorageRoots()
      // Stamp the exclusion *before* the node can write a session into it — a blob that is
      // created and then backed up before the flag lands is exactly the rollback we are
      // preventing. Both roots are marked: Caches is already outside backup, but the exclusion
      // should be structural rather than an artifact of where the dir happens to live.
      excludeFromBackup(roots.state)
      excludeFromBackup(roots.data)
      let host = nodeHost()
      // Adopts the live node when the identity matches — including one the background runtime
      // built and started on a JS-free launch — and builds otherwise. Never refused.
      let node = try await host.acquireApp(
        identitySecret: identityHex.map(hexToData),
        recvSecret: recvHex.map(hexToData),
        dataRoot: roots.data.path,
        stateRoot: roots.state.path)
      self.nodeLock.lock()
      self.leases += 1
      self.nodeLock.unlock()
      // A replacement (a different identity) is a new node: the getter re-attaches the watch.
      _ = self.node
      return [
        "endpointId": dataToHex(node.endpointId()),
        "identitySecret": dataToHex(node.identitySecret()),
        "recvSecret": dataToHex(node.recvSecret()),
        "recvPublic": dataToHex(node.recvPublic()),
      ]
    }

    AsyncFunction("start") { (relayUrls: [String], relayAuthToken: String, relayEnabled: Bool, ipEnabled: Bool, bleEnabled: Bool) async throws in
      // Idempotent: if the background runtime already started this node from the stored settings,
      // this is a no-op rather than the `AlreadyOpen` it used to be.
      try await self.node?.start(
        relayUrls: relayUrls,
        relayAuthToken: relayAuthToken,
        relayEnabled: relayEnabled,
        ipEnabled: ipEnabled,
        bleEnabled: bleEnabled)
    }

    AsyncFunction("shutdown") { () async in
      // Return one lease. The host shuts the node down only when nobody — no other JS context, not
      // the background runtime — still holds it.
      self.nodeLock.lock()
      guard self.leases > 0 else {
        self.nodeLock.unlock()
        return
      }
      self.leases -= 1
      let last = self.leases == 0
      self.nodeLock.unlock()
      if last { self.clearModuleRuntime() }
      _ = await nodeHost().release(holder: .app, timeoutMs: Self.shutdownBudgetMs)
    }

    /// Rebuild the node with new transport settings, keeping every holder's lease.
    ///
    /// What a settings change and a Bluetooth permission granted after construction both need. It
    /// used to be `shutdown` + `createNode` + `start` from JS, which with a shared node would only
    /// return this module's lease and adopt the same node back. The host starts the new node
    /// before anyone else can, so it cannot come up on the stored (old) settings.
    AsyncFunction("restartNode") {
      (relayUrls: [String], relayAuthToken: String, relayEnabled: Bool, ipEnabled: Bool,
        bleEnabled: Bool) async throws in
      self.nodeLock.lock()
      let held = self.leases
      self.nodeLock.unlock()
      guard held > 0 else {
        throw Exception(name: "NoNode", description: "call createNode first")
      }
      _ = try await nodeHost().restart(
        config: TransportConfig(
          relayUrls: relayUrls, relayAuthToken: relayAuthToken, relayEnabled: relayEnabled,
          ipEnabled: ipEnabled, bleEnabled: bleEnabled),
        timeoutMs: Self.restartBudgetMs)
      // The new node has no listener; touching the getter attaches the watch before JS asks.
      _ = self.node
    }

    /// Announce, as `onReplicaChanged`, each friend whose fix or null slot becomes readable.
    ///
    /// Replication runs whether or not anyone listens; this only stops JS having to poll the
    /// replica to notice. Kept across node restarts and replacements by this module.
    Function("watchReplica") {
      let bridge = ReplicaBridge(module: self)
      self.nodeLock.lock()
      self.replicaBridge = bridge
      self.nodeLock.unlock()
      self.node?.watchReplica(listener: bridge)
    }

    Function("unwatchReplica") {
      self.nodeLock.lock()
      self.replicaBridge = nil
      self.nodeLock.unlock()
      self.node?.unwatchReplica()
    }

    /// The host's view of who holds the node, for `device.health`.
    Function("nodeHostSnapshot") { () -> [String: Any] in
      let snapshot = nodeHost().snapshot()
      return [
        "generation": Double(snapshot.generation),
        "hasNode": snapshot.hasNode,
        "appLeases": Int(snapshot.appLeases),
        "background": snapshot.background,
        "builds": Double(snapshot.builds),
        "adoptions": Double(snapshot.adoptions),
        "replacements": Double(snapshot.replacements),
        "restarts": Double(snapshot.restarts),
        "shutdowns": Double(snapshot.shutdowns),
        "shutdownFailures": Double(snapshot.shutdownFailures),
        "shutdownTimeouts": Double(snapshot.shutdownTimeouts),
        "heals": Double(snapshot.heals),
      ]
    }

    /// Whether this phone currently reaches nobody, and what has been done about it (`isolation.rs`).
    /// `rebuildDue` is the mounted app's cue to heal through `rebindNode`; with no app holding the
    /// node the Rust core heals it itself.
    Function("isolationStatus") { () -> [String: Any] in
      let status = isolationStatus()
      var out: [String: Any] = [
        "isolated": status.isolated,
        "silentPasses": Int(status.silentPasses),
        "networkChanges": Int(status.networkChanges),
        "rebuilds": Int(status.rebuilds),
        "rebuildDue": status.rebuildDue,
        "episodes": Int(status.episodes),
        "recoveries": Int(status.recoveries),
      ]
      if let at = status.isolatedSinceMs { out["isolatedSinceMs"] = Double(at) }
      if let at = status.lastAnswerMs { out["lastAnswerMs"] = Double(at) }
      if let at = status.lastRebuildMs { out["lastRebuildMs"] = Double(at) }
      return out
    }

    // A module torn down without its JS calling `shutdown` (a reload, a crashed context) would
    // otherwise hold its leases for the life of the process: the node would never be shut down
    // and never have this module's listeners detached. Return them.
    OnDestroy {
      self.nodeLock.lock()
      let held = self.leases
      self.leases = 0
      self.nodeLock.unlock()
      guard held > 0 else { return }
      Task {
        for _ in 0..<held {
          _ = await nodeHost().release(holder: .app, timeoutMs: IrohLocationModule.shutdownBudgetMs)
        }
      }
    }

    // MARK: - Device identity (the background drain path's own copy)

    /// Seed the Keychain item the background path reads. Idempotent; JS calls it once after
    /// `createNode` and skips it thereafter via `deviceSecretsProvisioned`.
    AsyncFunction("saveDeviceSecrets") { (identityHex: String, recvHex: String) async throws in
      try KeychainDeviceSecrets.shared.save(
        identity: hexToData(identityHex), recv: hexToData(recvHex))
    }

    Function("deviceSecretsProvisioned") { () -> Bool in
      KeychainDeviceSecrets.shared.isProvisioned()
    }

    /// No counterpart on iOS: Core Location's background updates need no notification, and the
    /// blue status bar indicator the OS shows instead is not something an app can request or
    /// suppress. Present so callers do not have to branch on platform.
    AsyncFunction("ensureNotificationPermission") { () async -> Bool in
      true
    }

    /// Remember the transport settings, so the background runtime can `start` without JS.
    AsyncFunction("setTransportConfig") {
      (relayUrls: [String], relayAuthToken: String, relayEnabled: Bool, ipEnabled: Bool,
        bleEnabled: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setTransportConfig(
        config: TransportConfig(
          relayUrls: relayUrls, relayAuthToken: relayAuthToken, relayEnabled: relayEnabled,
          ipEnabled: ipEnabled, bleEnabled: bleEnabled))
    }

    /// Hand one captured fix to the native pipeline: gate → outbox → seal → own docs namespace.
    /// The mounted app's captures come through here; the background runtime calls the same node
    /// method directly.
    AsyncFunction("ingestFix") {
      (fix: [String: Double], battery: [String: Any], intervalMs: Double)
        async throws -> [String: Any?] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return ingestOutcomeToDict(
        try await node.ingestFix(
          fix: locationFix(from: fix),
          battery: batteryState(from: battery),
          intervalMs: UInt64(max(1, intervalMs)),
          nowMs: UInt64(Date().timeIntervalSince1970 * 1000)))
    }

    /// Publish the slots that have come due without a new fix, reusing the last known position.
    /// Driven on a timer by the mounted app — neither platform gives a background process a
    /// reliable one, and the cadence has to stay uniform whether or not the phone is moving.
    /// `parked` is the caller's motion claim (`nil` for none) — see `publish::Motion`.
    AsyncFunction("heartbeatFix") {
      (battery: [String: Any], intervalMs: Double, parked: Bool?)
        async throws -> [String: Any?] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return ingestOutcomeToDict(
        try await node.heartbeatFix(
          battery: batteryState(from: battery),
          intervalMs: UInt64(max(1, intervalMs)),
          nowMs: UInt64(Date().timeIntervalSince1970 * 1000),
          parked: parked))
    }

    /// Seal the last known position once for a recipient set that has just grown — a new friend's
    /// first dot. Declared in the TS contract and called by `connectNewFriend` since it existed,
    /// and exported by neither platform until the export-parity test found it.
    AsyncFunction("publishIntroduction") { () async throws -> [String: Any?] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return ingestOutcomeToDict(
        try await node.publishIntroduction(
          nowMs: UInt64(Date().timeIntervalSince1970 * 1000)))
    }

    /// Start/stop the native background runtime. The app calls these when the user turns sharing on
    /// and off; nothing else should.
    Function("startNativeBackground") {
      // Wire the handoff before starting, or the first captures of a mounted session have nowhere
      // to go — and on a fresh install those are the only ones there are.
      BackgroundLocationRuntime.shared.eventSink = self
      BackgroundLocationRuntime.shared.start()
      // Seed explicitly, because `start()` is idempotent: if the app-delegate bootstrap already
      // armed the ladder, `start()` returned without seeding and its own seed was captured before
      // this sink existed. Without this the gate is never seeded — armed, authorised, running and
      // publishing nothing, the 2026-08-30 failure.
      BackgroundLocationRuntime.shared.seedGateFromCache()
    }

    /// Re-program the background runtime from the sampling policy's decision.
    Function("setBackgroundCadence") { (intervalMs: Double, distanceM: Double, accuracy: String) in
      BackgroundLocationRuntime.shared.setCadence(
        intervalMs: UInt64(max(1, intervalMs)), distanceM: distanceM, accuracy: accuracy)
    }

    /// Whether the background runtime is the one currently receiving locations.
    Function("nativeBackgroundRunning") { () -> Bool in
      BackgroundLocationRuntime.shared.isRunning
    }

    /// What the runtime is doing and why, for `device.health`.
    ///
    /// Reports the moving/stopped state, the reason it last ran, whether the stop-anchor fence is
    /// actually registered, and the live authorization — the four things that previously had to be
    /// inferred from an absence of spans, which is to say could not be inferred at all.
    Function("nativeBackgroundState") { () -> [String: Any] in
      BackgroundLocationRuntime.shared.healthSnapshot
    }

    /// How much of its background execution budget this app has been spending.
    ///
    /// The denominator every other claim about the background budget has been missing: until this
    /// existed, "iOS took our execution away" could only be inferred from silence, and MetricKit
    /// reported it on the launch AFTER the one that offended. `cpu_ms_max` approaching 48 000 is
    /// not "high" — it is `MXCPUExceptionDiagnostic`'s threshold, the constant every one of the 41
    /// diagnostics in that 7-day window reported.
    ///
    /// Read-only. Resetting is a separate call so two health records in the same minute cannot
    /// each take half the counts — see `BackgroundWakeLedger.reset`.
    Function("takeBackgroundWakeStats") { () -> [String: Any] in
      BackgroundWakeLedger.snapshot
    }

    /// Clear the wake counters. Called by whoever owns the reporting cadence, and nothing else.
    Function("resetBackgroundWakeStats") {
      BackgroundWakeLedger.reset()
    }

    /// Whether Core Location grants background updates **right now**.
    ///
    /// Distinct from `expo-location`'s request round-trip, which on a fresh install returns before
    /// the delegate has settled and made a phone holding `authorizedAlways` report `foreground` for
    /// an evening. Read this instead of latching that.
    Function("nativeBackgroundAuthorized") { () -> Bool in
      BackgroundLocationRuntime.shared.hasBackgroundAuthorization
    }

    Function("stopNativeBackground") {
      BackgroundLocationRuntime.shared.stop()
    }

    /// This JS runtime is going away, but sharing is NOT off. Keep every rung of the ladder armed.
    ///
    /// The difference from `stopNativeBackground` is the difference between the user switching
    /// sharing off and a process teardown, and only the first should disarm SLC, the stop fence and
    /// the persisted anchor. Dropping the sink is the point: with no JS to hand captures to, the
    /// runtime publishes them itself, through the same node (its lease keeps it alive once the
    /// app's `shutdown` returns the app's).
    Function("releaseNativeBackground") {
      BackgroundLocationRuntime.shared.eventSink = nil
    }

    // MARK: - Native publish state

    AsyncFunction("currentSeq") { () async throws -> Double in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Double(try await node.currentSeq())
    }

    AsyncFunction("seedSeq") { (floor: Double) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.seedSeq(floor: UInt64(max(0, floor)))
    }

    AsyncFunction("setSharingRecipients") {
      (recipientEndpointsHex: [String], watcherEndpointsHex: [String]) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setSharingRecipients(
        recipientEndpoints: recipientEndpointsHex, watcherEndpoints: watcherEndpointsHex)
    }

    // Mirror each friend's receiving key so the native drain can run session recovery (§4.6) on a
    // wake with no JS alive. Two parallel lists, built by JS from the same pool in one pass.
    AsyncFunction("setRecipientKeys") {
      (endpointsHex: [String], recvPublicsHex: [String]) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setRecipientKeys(
        keys: zip(endpointsHex, recvPublicsHex).map { RecipientKey(endpointId: $0, recvPublic: $1) })
    }

    // Who the latest fix envelope was sealed for and who it left out, and why. nil before the first
    // seal. `device.health` reports it as `ratchet.dropped*`.
    AsyncFunction("lastSealReport") { () async throws -> [String: Any]? in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      guard let r = try await node.lastSealReport() else { return nil }
      return [
        "at": Double(r.at), "recipients": Double(r.recipients), "dropped": Double(r.dropped),
        "lapsed": Double(r.lapsed), "noSession": Double(r.noSession), "other": Double(r.other),
        "droppedPeers": r.droppedPeers,
      ]
    }

    // Read the durable sharing set back. `device.health` reports its size next to the pool's, so a
    // phone whose JS pool and native list have diverged says so instead of reading healthy.
    AsyncFunction("sharingRecipients") { () async throws -> [String] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.sharingRecipients()
    }

    // Record where a drained envelope must be SENT to leave the device. The companion to
    // `setSharingRecipients`: that one says who to seal for, this one says who to hand the sealed
    // bytes to. Without it the drain publishes into a local replica nothing reconciles with.
    AsyncFunction("setDeliveryConfig") {
      (peerTickets: [String], stashBaseUrl: String?, stashPsk: String?) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setDeliveryConfig(
        config: DeliveryConfig(
          peerTickets: peerTickets, stashBaseUrl: stashBaseUrl, stashPsk: stashPsk))
    }

    // When the native drain last accepted, published and pushed. `device.health` reports these as
    // ages; the JS watermark row only ever saw the JS publish path, which the drain replaced.
    AsyncFunction("publishWatermarks") { () async throws -> [String: Any?] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let w = try await node.publishWatermarks()
      return [
        "lastAcceptedAt": w.lastAcceptedAt.map { Double($0) },
        "lastPublishedAt": w.lastPublishedAt.map { Double($0) },
        "lastPushedAt": w.lastPushedAt.map { Double($0) },
      ]
    }

    // Every position the drain published since the app last asked — how a stretch published with
    // no JS alive reaches the own trail and the exploration map. See `own_log.rs`.
    AsyncFunction("takeOwnPublished") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.takeOwnPublished().map { ["seq": Double($0.seq), "fix": fixToDict($0.fix)] }
    }

    AsyncFunction("outboxPending") { () async throws -> Double in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Double(try await node.outboxPending())
    }

    AsyncFunction("clearOutbox") { () async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.clearOutbox()
    }

    AsyncFunction("ticket") { () async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.ticket()
    }

    // Map tile decode (see rust/src/mvt.rs). AsyncFunction runs off the JS thread.
    // Bytes cross as Uint8Array <-> Data. Requires `just bindgen-ios` (macOS) so the
    // UniFFI Swift bindings include these free functions.
    AsyncFunction("decodeMvtBundle") { (bundle: Data) throws -> Data in
      try decodeMvtBundle(bundle: bundle)
    }

    AsyncFunction("decodeMvtTile") { (bytes: Data, z: Int, x: Int, y: Int) -> Data in
      decodeMvtTile(bytes: bytes, z: UInt32(z), x: UInt32(x), y: UInt32(y))
    }

    AsyncFunction("h3CellsForPolygon") { (coordinates: [Double], resolution: Int) throws -> [String] in
      try h3CellsForPolygon(coordinates: coordinates, resolution: UInt8(resolution))
    }

    // Ratchet sessions + 4.6 recovery.
    //
    // There is deliberately no `beginSession`/`completeSession` here. A session is bootstrapped by
    // the SAS bump itself (pairing.rs), from ephemerals that are signed, connection-pinned and
    // folded into the figure the two humans compared — so there is no JS-callable seam that could
    // root a session from anything weaker. What JS drives is only recovery.

    AsyncFunction("isDesynced") { (peerEndpoint: String) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.isDesynced(peerEndpointHex: peerEndpoint)
    }

    AsyncFunction("resyncCount") { (peerEndpoint: String) async throws -> Int in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Int(try await node.resyncCount(peerEndpointHex: peerEndpoint))
    }

    AsyncFunction("forgetSession") { (peerEndpoint: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.forgetSession(peerEndpointHex: peerEndpoint)
    }

    // Companion to forgetSession: erase the pairing record of how the friendship began, not just
    // the ratchet state of what it became. Finished sessions only — a live pair is the user's to
    // cancel. Returns how many were dropped.
    AsyncFunction("forgetPairSessions") { (peerEndpoint: String) async throws -> Int in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Int(try await node.forgetPairSessions(peerEndpointHex: peerEndpoint))
    }

    AsyncFunction("syncLatest") { (peerTickets: [String], traceparent: String?) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.syncLatest(peerTickets: peerTickets, traceparent: traceparent)
    }

    AsyncFunction("readLatest") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let events = try await node.readLatestRatchetedEvents()
      return events.map { incoming in
        [
          "author": dataToHex(incoming.author),
          "seq": incoming.seq,
          "ts": incoming.ts,
          "kind": incoming.kind,
          "fix": incoming.fix.map { fixToDict($0) } as Any,
          "viaPeer": incoming.viaPeer as Any,
        ]
      }
    }

    AsyncFunction("pruneTrail") { (olderThanTs: Double) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.pruneTrail(olderThanTs: UInt64(olderThanTs))
    }

    AsyncFunction("docTicket") { () async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.docTicket()
    }

    AsyncFunction("importDocTicket") { (ticket: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.importDocTicket(ticket: ticket)
    }

    // Stop replicating a removed friend's trail / profile namespace, and stop reopening it on
    // every start (`ns_book.rs`). Returns whether we were replicating it.
    AsyncFunction("forgetDocTicket") { (ticket: String) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.forgetDocTicket(ticket: ticket)
    }

    AsyncFunction("forgetProfileTicket") { (ticket: String) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.forgetProfileTicket(ticket: ticket)
    }

    // Grant the trail stash our namespaces now (`stash.rs`). Returns at once; the HTTP runs on its
    // own task and reports as a `stash.grant` span.
    AsyncFunction("grantStash") { () async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      await node.grantStashNow()
    }

    // ── Repeaters — see docs/social/REPEATERS.md ────────────────────────────────────────────

    // Claim the repeater whose console printed `link` into the roster this phone owns, and list it
    // there. Refused unless its signed cert names this phone, this roster and the machine that
    // answered (`repeater.rs`).
    AsyncFunction("claimRepeater") { (link: String, open: Bool, carryMe: Bool) async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let c = try await node.claimRepeater(link: link, open: open, carryMe: carryMe)
      return ["rosterId": c.rosterId, "repeaterId": c.repeaterId]
    }

    // Every roster this phone knows, for Settings → Repeaters.
    AsyncFunction("repeaterRosters") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.repeaterRosters().map { r in
        [
          "rosterId": r.rosterId, "owner": r.owner, "mine": r.mine, "open": r.open,
          "carriesMe": r.carriesMe, "repeaters": r.repeaters, "repeaterNames": r.repeaterNames,
          "carried": Double(r.carried),
          "members": r.members, "vouchers": r.vouchers, "canEnroll": r.canEnroll,
          "inviters": r.inviters, "invited": r.invited, "canInvite": r.canInvite,
          "waiting": r.waiting,
        ]
      }
    }

    // Invite someone to an invite-only roster we may invite to. Resolves whether a new invite was
    // signed; an invite carries nobody until they enroll.
    AsyncFunction("inviteToRepeater") { (rosterId: String, member: String) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.inviteToRepeater(rosterId: rosterId, member: member)
    }

    // Invite a new friend to every invite-only roster we may invite to (the pairing screen's
    // "also invite them"). Resolves how many invites were signed.
    AsyncFunction("inviteFriendToRepeaters") { (member: String) async throws -> Double in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Double(try await node.inviteFriendToRepeaters(member: member))
    }

    // Owner only: let someone invite people to our roster, or stop them.
    AsyncFunction("setRepeaterInviter") { (rosterId: String, member: String, inviter: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setRepeaterInviter(rosterId: rosterId, member: member, inviter: inviter)
    }

    AsyncFunction("repeaterAutoInvite") { () async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.repeaterAutoInvite()
    }

    AsyncFunction("setRepeaterAutoInvite") { (on: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setRepeaterAutoInvite(on: on)
    }

    // What device.health reports about repeaters. A local read.
    AsyncFunction("repeaterHealth") { () async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let h = try await node.repeaterHealth()
      return [
        "enrolled": Double(h.enrolled), "carriers": Double(h.carriers),
        "lastContactAgeMs": h.lastContactAgeMs.map { Double($0) as Any } ?? NSNull(),
      ]
    }

    // Have a roster carry our trail, or stop. Resolves whether it carries us now.
    AsyncFunction("setRepeaterCarried") { (rosterId: String, carry: Bool) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.setRepeaterCarried(rosterId: rosterId, carry: carry)
    }

    // Owner only: who may enroll in our roster from now on. Never drops anyone already carried.
    AsyncFunction("setRepeaterPolicy") { (rosterId: String, open: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.setRepeaterPolicy(rosterId: rosterId, open: open)
    }

    // Owner only: stop carrying a member's trail. Sticky until someone invites them again.
    AsyncFunction("removeRepeaterMember") { (rosterId: String, member: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.removeRepeaterMember(rosterId: rosterId, member: member)
    }

    // Owner only: take a machine out of our roster.
    AsyncFunction("removeRepeater") { (rosterId: String, repeaterId: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.removeRepeater(rosterId: rosterId, repeaterId: repeaterId)
    }

    // Pick up names this phone's own machines were given at their consoles. Dials each machine:
    // only for Settings → Repeaters, never a background wake. Resolves how many were re-listed.
    AsyncFunction("refreshRepeaterNames") { () async throws -> Double in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return Double(try await node.refreshRepeaterNames())
    }

    // Ask every repeater that carries us to carry our namespaces now. Resolves at once; the dials
    // run on a native task and report as a `repeater.grant` span.
    AsyncFunction("grantRepeaters") { () async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      await node.grantRepeatersNow()
    }

    Function("configureTelemetry") { (endpoint: String, instanceId: String) -> Bool in
      TelemetryConfigurator.apply(endpoint: endpoint, instanceId: instanceId, remember: true)
    }

    AsyncFunction("flushTelemetry") { () async in
      await flushTelemetry()
    }

    // Debug screen: send every queued Rust span and log now, ignoring the spool's backoff.
    AsyncFunction("pushTelemetryNow") { () async -> [String: Any] in
      let r = await pushTelemetryNow()
      return [
        "configured": r.configured, "delivered": r.delivered, "dropped": r.dropped,
        "reachable": r.reachable, "remainingBatches": r.remainingBatches,
        "remainingBytes": r.remainingBytes,
      ]
    }

    // ── Profiles — see docs/social/ARCHITECTURE.md §3 ─────────────────────────────────────

    AsyncFunction("publishProfile") {
      (handle: String, cryptidName: String, sigil: String, color: String) async throws -> UInt64 in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.publishProfile(
        handle: handle, cryptidName: cryptidName, sigil: sigil, color: color)
    }

    AsyncFunction("profileTicket") { () async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.profileTicket()
    }

    AsyncFunction("importProfileTicket") { (ticket: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.importProfileTicket(ticket: ticket)
    }

    AsyncFunction("readProfile") { (endpointIdHex: String) async throws -> [String: Any]? in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (try await node.readProfile(endpointId: hexToData(endpointIdHex))).map { profileViewDict($0) }
    }

    AsyncFunction("pollProfileEvents") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (await node.pollProfileEvents()).map { profileViewDict($0) }
    }

    // ── Bilateral pairing (`streetcryptid/pair/4`) — ARCHITECTURE.md §4 ─────────────────────

    AsyncFunction("setPairingReady") { (ready: Bool) throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      node.setPairingReady(ready: ready)
    }

    AsyncFunction("pairingReady") { () throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return node.pairingReady()
    }

    AsyncFunction("createPairInvite") { (ttlSecs: Double) async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let inv = try await node.createInvite(ttlSecs: UInt64(ttlSecs))
      var dict = pairInviteDict(inv)
      dict["token"] = try encodePairInvite(invite: inv)
      return dict
    }

    // The token, not a decoded invite: it is the only form the app still holds once the link has
    // been handed out, and `CANCEL LINK` is the one caller.
    AsyncFunction("revokePairInvite") { (token: String) async throws -> Bool in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.revokePairInvite(token: token)
    }

    AsyncFunction("initiatePair") { (invite: [String: Any]) async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return dataToHex(try await node.initiatePair(invite: pairInvite(from: invite)))
    }

    AsyncFunction("initiatePairByToken") { (token: String) async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return dataToHex(try await node.initiatePairByTicket(token: token))
    }

    AsyncFunction("initiatePairNearby") { (peerEndpointIdHex: String) async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return dataToHex(try await node.initiatePairNearby(peerEndpointId: hexToData(peerEndpointIdHex)))
    }

    AsyncFunction("respondPair") { (sessionIdHex: String, accept: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.respondPair(sessionId: hexToData(sessionIdHex), accept: accept)
    }

    AsyncFunction("pairSasChallenge") { (sessionIdHex: String) async throws -> [String: Any]? in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (try await node.pairSasChallenge(sessionId: hexToData(sessionIdHex))).map { sasChallengeDict($0) }
    }

    AsyncFunction("submitPairChoice") { (sessionIdHex: String, chosenIndex: Double) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.submitPairChoice(
        sessionId: hexToData(sessionIdHex), chosenIndex: try pairingFigureIndex(chosenIndex))
    }

    AsyncFunction("confirmPairDisplay") { (sessionIdHex: String, matched: Bool) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.confirmPairDisplay(sessionId: hexToData(sessionIdHex), matched: matched)
    }

    AsyncFunction("cancelPair") { (sessionIdHex: String) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      try await node.cancelPair(sessionId: hexToData(sessionIdHex))
    }

    AsyncFunction("pollPairEvents") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (await node.pollPairEvents()).map { pairEventDict($0) }
    }

    AsyncFunction("pairState") { (sessionIdHex: String) async throws -> [String: Any]? in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (try await node.pairState(sessionId: hexToData(sessionIdHex))).map { pairStateRecordDict($0) }
    }

    AsyncFunction("listPairSessions") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (await node.listPairSessions()).map { pairStateRecordDict($0) }
    }

    AsyncFunction("pairResult") { (sessionIdHex: String) async throws -> [String: Any]? in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (try await node.pairResult(sessionId: hexToData(sessionIdHex))).map { pairResultDict($0) }
    }

    AsyncFunction("transportDiagnostics") { (peerEndpointIdsHex: [String]) async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let peerEndpointIds = peerEndpointIdsHex.map { hexToData($0) }
      return transportDiagnosticsDict(try await node.transportDiagnostics(peerEndpointIds: peerEndpointIds))
    }

    // What this replica can SERVE, per author — presence, never payload.
    AsyncFunction("trailReplicaStatus") { () async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return (try await node.trailReplicaStatus()).map { slot in
        [
          "author": dataToHex(slot.author),
          "seq": slot.seq,
          "fixTs": slot.fixTs,
          "hasContent": slot.hasContent,
        ]
      }
    }

    AsyncFunction("encodePairInvite") { (invite: [String: Any]) throws -> String in
      try encodePairInvite(invite: pairInvite(from: invite))
    }

    AsyncFunction("decodePairInvite") { (token: String) throws -> [String: Any] in
      pairInviteDict(try decodePairInvite(token: token))
    }

    // Pure decode, node-free: lets JS recognise a configured stash by its EndpointId.
    AsyncFunction("endpointIdFromTicket") { (ticket: String) throws -> String in
      try endpointIdFromTicket(ticket: ticket)
    }

    // ── BLE status (honest stub off-device) — ARCHITECTURE.md §2 ───────────────────────────

    AsyncFunction("bleAvailable") { () async -> Bool in
      guard let node = self.node else { return false }
      return await node.bleAvailable()
    }

    AsyncFunction("bluetoothRadioState") { () async -> String in
      await BluetoothRadioProbe.shared.state()
    }

    AsyncFunction("bleCapabilities") { () async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return bleCapabilitiesDict(await node.bleCapabilities())
    }

    AsyncFunction("nearbyBlePeers") { () async -> [[String: Any]] in
      guard let node = self.node else { return [] }
      return (await node.nearbyBlePeers()).map { blePeerDict($0) }
    }

    AsyncFunction("resolveBumpPeer") { (timeoutMs: Double) async throws -> [String: Any] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return bumpResolutionDict(await node.resolveBumpPeer(timeoutMs: UInt64(timeoutMs)))
    }

    AsyncFunction("bleHasScanHint") { (endpointIdHex: String) async -> Bool in
      guard let node = self.node else { return false }
      return await node.bleHasScanHint(endpointId: hexToData(endpointIdHex))
    }

    // ── MetricKit: the OS's account of how the app last ended ────────────────────────────────
    //
    // Subscribed from module creation rather than lazily, because MetricKit delivers a payload
    // shortly AFTER launch and never redelivers one. A subscriber registered when JavaScript
    // first asks for diagnostics would miss the launch that followed the crash it is asking
    // about — which is every launch that matters.
    OnCreate {
      MetricKitDiagnostics.shared.start()
      // Module creation IS a JS boot: this block runs when the JavaScript module registry is
      // built, which happens once per React Native start and never without one. That makes it the
      // honest place to count them — `wake.bg_launches` climbing while `wake.js_boots` tracks it
      // is how you see that a background launch is still paying for the whole bundle, and after
      // the deferral lands it is how you see that it has stopped.
      BackgroundWakeLedger.noteJsBoot()
    }

    /// Drain the diagnostics stored since the last call. Each string is a JSON object.
    /// Absent on Android and on older iOS binaries, so callers must guard on its presence.
    AsyncFunction("takeCrashDiagnostics") { () -> [String] in
      MetricKitDiagnostics.shared.take()
    }
  }
}
