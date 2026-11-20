import Foundation
import XCTest

@testable import RepeaterCore

final class HostSessionTests: XCTestCase {
  @MainActor
  func testHostReceivesCommandsAndEOFStopsItWithoutReplacingIdentity() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let executable = directory.appendingPathComponent("host")
    let snapshot = """
      {"protocol":2,"kind":"snapshot","runId":"test","snapshot":{"protocol":2,"version":"1.0.0","mode":"user","endpointId":"test","claimed":false,"members":[],"tracked":0,"missing":0,"received":0,"connections":0,"connectionsOpened":0,"bytesReceived":0,"bytesSent":0,"settings":{"telemetry":false,"keepAwake":false},"telemetryAvailable":false,"keepAwakeHeld":false}}
      """
    let script = """
      #!/bin/sh
      printf '%s\\n' '\(snapshot)'
      while IFS= read -r line; do
        printf '%s\\n' "$line" > '\(directory.path)/command'
        id=$(printf '%s' "$line" | /usr/bin/sed -E 's/.*"requestId":"([^"]*)".*/\\1/')
        printf '{"protocol":2,"kind":"result","runId":"test","requestId":"%s","ok":true}\\n' "$id"
      done
      touch '\(directory.path)/stopped'
      """
    try Data(script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let session = HostSession(
      executable: executable, stateDirectory: directory.appendingPathComponent("state"))
    session.start()
    for _ in 0..<100 {
      if session.running { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    XCTAssertTrue(session.running, session.problem ?? "")
    let command = HostCommand(kind: "settings", settings: HostSettings(keepAwake: true))
    try await session.send(command)
    let received = try Data(contentsOf: directory.appendingPathComponent("command"))
    let object = try JSONSerialization.jsonObject(with: received) as! [String: Any]
    XCTAssertEqual(object["requestId"] as? String, command.requestId)
    await session.stop()
    XCTAssertTrue(
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("stopped").path))
    XCTAssertFalse(session.running)
  }
}
