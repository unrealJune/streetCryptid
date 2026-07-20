import ExpoModulesCore

// The UniFFI-generated Swift bindings for the `iroh-location` Rust crate are compiled
// into this target (see IrohLocation.podspec -> vendored xcframework + generated/*.swift).
// They expose: `LocationNode`, `Subscription`, the `FixListener` protocol, the profile /
// pairing / BLE records + enums, and the free functions `deriveTopic(authorEndpointId:)`,
// `generateRecvKeypair()`, `encodePairInvite(invite:)`, and `decodePairInvite(token:)`.
//
// Regenerate with `just bindgen-ios` on macOS (source bindings can also be produced from a
// host library via `uniffi-bindgen ... --language swift`; only the XCFramework needs macOS).

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

/// Build the UniFFI `LocationFix` from the JS bridge dict.
private func locationFix(from fix: [String: Double]) -> LocationFix {
  LocationFix(
    lat: fix["lat"] ?? 0, lon: fix["lon"] ?? 0, accuracyM: fix["accuracyM"] ?? 0,
    headingDeg: fix["headingDeg"] ?? 0, ts: UInt64(fix["ts"] ?? 0))
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

/// Bridges inbound Rust gossip events to the JS EventEmitter.
private final class EventBridge: FixListener {
  weak var module: IrohLocationModule?
  let subscriptionId: String
  init(module: IrohLocationModule, subscriptionId: String) {
    self.module = module
    self.subscriptionId = subscriptionId
  }
  // `backfill` is `true` when the fix arrived via durable range-reconciliation (iroh-docs
  // catch-up) rather than the live gossip path.
  func onFix(author: Data, seq: UInt64, fix: LocationFix, backfill: Bool) {
    module?.sendEvent(
      "onFix",
      [
        "author": dataToHex(author),
        "seq": seq,
        "fix": [
          "lat": fix.lat, "lon": fix.lon, "accuracyM": fix.accuracyM,
          "headingDeg": fix.headingDeg, "ts": fix.ts,
        ],
        "backfill": backfill,
      ])
  }
  func onOpaque(author: Data, seq: UInt64) {
    module?.sendEvent("onOpaque", ["author": dataToHex(author), "seq": seq])
  }
  func onStatus(status: String) {
    module?.sendEvent("onStatus", ["subscriptionId": subscriptionId, "status": status])
  }
  // Durable-trail sync progress for an author/namespace: `started` | `completed` | `error`.
  func onSync(author: Data, status: String, recovered: UInt64?) {
    var payload: [String: Any] = ["author": dataToHex(author), "status": status]
    if let recovered = recovered { payload["recovered"] = recovered }
    module?.sendEvent("onSync", payload)
  }
}

public final class IrohLocationModule: Module {
  private var node: LocationNode?
  private var subscriptions: [String: Subscription] = [:]
  private var bridges: [String: EventBridge] = [:]

  private func clearRuntime() async throws {
    subscriptions.removeAll()
    bridges.removeAll()
    try await node?.shutdown()
    node = nil
  }

  public func definition() -> ModuleDefinition {
    Name("IrohLocation")
    Events("onFix", "onOpaque", "onStatus", "onSync")

    AsyncFunction("createNode") { (identityHex: String?, recvHex: String?) async throws -> [String: String] in
      try await self.clearRuntime()
      let node = try LocationNode(
        identitySecret: identityHex.map(hexToData),
        recvSecret: recvHex.map(hexToData))
      self.node = node
      return [
        "endpointId": dataToHex(node.endpointId()),
        "identitySecret": dataToHex(node.identitySecret()),
        "recvSecret": dataToHex(node.recvSecret()),
        "recvPublic": dataToHex(node.recvPublic()),
      ]
    }

    AsyncFunction("start") { (relayUrls: [String], relayAuthToken: String) async throws in
      try await self.node?.start(relayUrls: relayUrls, relayAuthToken: relayAuthToken)
    }

    AsyncFunction("shutdown") { () async throws in
      try await self.clearRuntime()
    }

    AsyncFunction("ticket") { () async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      return try await node.ticket()
    }

    Function("deriveTopic") { (authorHex: String) -> String in
      dataToHex(deriveTopic(authorEndpointId: hexToData(authorHex)))
    }

    AsyncFunction("subscribe") { (topicHex: String, bootstrap: [String]) async throws -> String in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let subscriptionId = UUID().uuidString
      let bridge = EventBridge(module: self, subscriptionId: subscriptionId)
      let sub = try await node.subscribe(
        topic: hexToData(topicHex), bootstrap: bootstrap, listener: bridge)
      self.subscriptions[subscriptionId] = sub
      self.bridges[subscriptionId] = bridge
      return subscriptionId
    }

    AsyncFunction("publish") {
      (subscriptionId: String, seq: Double, epoch: Double, fix: [String: Double], recipients: [String], traceparent: String?) async throws in
      guard let sub = self.subscriptions[subscriptionId] else { return }
      if let traceparent {
        try await sub.publishTraced(
          seq: UInt64(seq), epoch: UInt32(epoch), fix: locationFix(from: fix),
          recipients: recipients.map(hexToData), traceparent: traceparent)
      } else {
        try await sub.publish(
          seq: UInt64(seq), epoch: UInt32(epoch), fix: locationFix(from: fix),
          recipients: recipients.map(hexToData))
      }
    }

    AsyncFunction("unsubscribe") { (subscriptionId: String) in
      self.subscriptions.removeValue(forKey: subscriptionId)
      self.bridges.removeValue(forKey: subscriptionId)
    }

    // ── Durable trail (iroh-docs) — see docs/social/ARCHITECTURE.md §5–6 ──────────────────

    AsyncFunction("docsWrite") {
      (subscriptionId: String, seq: Double, epoch: Double, fix: [String: Double], recipients: [String], traceparent: String?) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      if let traceparent {
        try await node.docsWriteTraced(
          subscriptionId: subscriptionId, seq: UInt64(seq), epoch: UInt32(epoch),
          fix: locationFix(from: fix), recipients: recipients.map(hexToData),
          traceparent: traceparent)
      } else {
        try await node.docsWrite(
          subscriptionId: subscriptionId, seq: UInt64(seq), epoch: UInt32(epoch),
          fix: locationFix(from: fix), recipients: recipients.map(hexToData))
      }
    }

    AsyncFunction("syncTrail") { (sinceTs: Double, peerTicket: String?, traceparent: String?) async throws in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      if let traceparent {
        try await node.syncTrailTraced(
          sinceTs: UInt64(sinceTs), peerTicket: peerTicket, traceparent: traceparent)
      } else {
        try await node.syncTrail(sinceTs: UInt64(sinceTs), peerTicket: peerTicket)
      }
    }

    AsyncFunction("readTrail") { (author: String, sinceTs: Double) async throws -> [[String: Any]] in
      guard let node = self.node else { throw Exception(name: "NoNode", description: "call createNode first") }
      let fixes = try await node.readTrail(author: hexToData(author), sinceTs: UInt64(sinceTs))
      return fixes.map { incoming in
        [
          "author": dataToHex(incoming.author),
          "seq": incoming.seq,
          "fix": [
            "lat": incoming.fix.lat, "lon": incoming.fix.lon, "accuracyM": incoming.fix.accuracyM,
            "headingDeg": incoming.fix.headingDeg, "ts": incoming.fix.ts,
          ],
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

    Function("configureTelemetry") { (endpoint: String, instanceId: String) -> Bool in
      configureTelemetry(endpoint: endpoint, instanceId: instanceId)
    }

    AsyncFunction("flushTelemetry") { () async in
      await flushTelemetry()
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

    // ── Bilateral pairing (`streetcryptid/pair/2`) — ARCHITECTURE.md §4 ─────────────────────

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

    AsyncFunction("encodePairInvite") { (invite: [String: Any]) throws -> String in
      try encodePairInvite(invite: pairInvite(from: invite))
    }

    AsyncFunction("decodePairInvite") { (token: String) throws -> [String: Any] in
      pairInviteDict(try decodePairInvite(token: token))
    }

    // ── BLE status (honest stub off-device) — ARCHITECTURE.md §2 ───────────────────────────

    AsyncFunction("bleAvailable") { () async -> Bool in
      guard let node = self.node else { return false }
      return await node.bleAvailable()
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
  }
}
