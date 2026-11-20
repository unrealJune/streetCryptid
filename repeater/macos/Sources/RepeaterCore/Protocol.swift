import Foundation

public struct HostSettings: Codable, Equatable {
  public var telemetry = false
  public var keepAwake = false
  public init(telemetry: Bool = false, keepAwake: Bool = false) {
    self.telemetry = telemetry
    self.keepAwake = keepAwake
  }
}

public struct Snapshot: Decodable {
  public let `protocol`: Int
  public let version: String
  public let mode: String
  public let endpointId: String
  public let name: String?
  public let listedName: String?
  public let claimed: Bool
  public let claimUrl: String?
  public let owner: String?
  public let policy: String?
  public let members: [String]
  public let tracked: UInt64
  public let missing: UInt64
  public let received: UInt64
  public let connections: UInt64
  public let connectionsOpened: UInt64
  public let bytesReceived: UInt64
  public let bytesSent: UInt64
  public let settings: HostSettings
  public let telemetryAvailable: Bool
  public let keepAwakeHeld: Bool
}

public struct HostMessage: Decodable {
  public let `protocol`: Int
  public let kind: String
  public let runId: String
  public let snapshot: Snapshot?
  public let requestId: String?
  public let ok: Bool?
  public let sequence: UInt64?

  public static func decode(_ data: Data) throws -> Self {
    let value = try JSONDecoder().decode(Self.self, from: data)
    guard value.protocol == 2, !value.runId.isEmpty else { throw HostError.protocolMismatch }
    switch value.kind {
    case "snapshot":
      guard value.snapshot?.protocol == 2, value.snapshot?.mode == "user" else {
        throw HostError.protocolMismatch
      }
    case "result":
      guard value.requestId != nil, value.ok != nil else { throw HostError.protocolMismatch }
    case "arrival":
      guard value.sequence != nil else { throw HostError.protocolMismatch }
    default: throw HostError.protocolMismatch
    }
    return value
  }
}

public enum HostError: LocalizedError {
  case protocolMismatch, lineTooLong, disconnected, timeout, refused

  public var errorDescription: String? {
    switch self {
    case .protocolMismatch: return "The bundled repeater uses an incompatible protocol."
    case .lineTooLong: return "The repeater sent an oversized message."
    case .disconnected: return "The repeater stopped. Its identity has been preserved."
    case .timeout: return "The repeater stopped answering. Check your network, then retry."
    case .refused: return "The repeater could not save that change."
    }
  }
}

public struct HostCommand: Encodable {
  public let `protocol` = 2
  public let kind: String
  public let requestId: String
  public let telemetry: Bool?
  public let keepAwake: Bool?
  public let name: String?

  public init(kind: String, settings: HostSettings? = nil, name: String? = nil) {
    self.kind = kind
    self.requestId = UUID().uuidString
    self.telemetry = settings?.telemetry
    self.keepAwake = settings?.keepAwake
    self.name = name
  }

  public func line() throws -> Data {
    var data = try JSONEncoder().encode(self)
    data.append(10)
    guard data.count <= 4096 else { throw HostError.lineTooLong }
    return data
  }
}

/// A read may split UTF-8 or contain several lines. Bound the unfinished line, not the read.
public struct LineDecoder {
  private var pending = Data()
  public let limit: Int
  public init(limit: Int = 1_048_576) { self.limit = limit }

  public mutating func append(_ data: Data) throws -> [Data] {
    var lines: [Data] = []
    for byte in data {
      if byte == 10 {
        lines.append(pending)
        pending = Data()
      } else {
        guard pending.count < limit else { throw HostError.lineTooLong }
        pending.append(byte)
      }
    }
    return lines
  }
}

public struct RetryBudget {
  private var attempts = 0
  private var healthySince: TimeInterval?
  public init() {}
  public mutating func receivedSnapshot(now: TimeInterval) {
    if healthySince == nil { healthySince = now }
    if now - (healthySince ?? now) >= 300 { attempts = 0 }
  }
  public mutating func nextDelay() -> TimeInterval? {
    healthySince = nil
    guard attempts < 3 else { return nil }
    attempts += 1
    return Double(attempts * 2)
  }
}
