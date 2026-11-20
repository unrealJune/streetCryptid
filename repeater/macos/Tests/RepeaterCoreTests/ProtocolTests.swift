import Foundation
import XCTest

@testable import RepeaterCore

final class ProtocolTests: XCTestCase {
  func testFragmentedUnicodeAndMultipleLines() throws {
    var decoder = LineDecoder(limit: 32)
    let bytes = Data("Kyoto \u{6CB3}\nnext\n".utf8)
    XCTAssertEqual(try decoder.append(bytes.prefix(7)), [])
    let lines = try decoder.append(bytes.dropFirst(7))
    XCTAssertEqual(lines.map { String(data: $0, encoding: .utf8)! }, ["Kyoto \u{6CB3}", "next"])
  }

  func testLimitAppliesToEachLineAndIncompleteInputIsBounded() throws {
    var decoder = LineDecoder(limit: 4)
    XCTAssertEqual(try decoder.append(Data("1234\n1234\n".utf8)).count, 2)
    XCTAssertEqual(try decoder.append(Data("1234".utf8)), [])
    XCTAssertThrowsError(try decoder.append(Data("5".utf8)))
  }

  func testRejectsIncompatibleAndIncompleteMessages() throws {
    for line in [
      #"{"protocol":1,"kind":"arrival","runId":"a","sequence":1}"#,
      #"{"protocol":2,"kind":"snapshot","runId":"a"}"#,
      #"{"protocol":2,"kind":"result","runId":"a","requestId":"r"}"#,
      #"{"protocol":2,"kind":"arrival","runId":"","sequence":1}"#,
      #"{"protocol":2,"kind":"unknown","runId":"a"}"#,
    ] {
      XCTAssertThrowsError(try HostMessage.decode(Data(line.utf8)))
    }
    let message = try HostMessage.decode(
      Data(
        #"{"protocol":2,"kind":"result","runId":"a","requestId":"r","ok":false,"future":1}"#.utf8
      ))
    XCTAssertEqual(message.ok, false)
  }

  func testCommandsUseHostWireWithoutUnrelatedFields() throws {
    let settings = HostCommand(kind: "settings", settings: HostSettings(telemetry: true))
    let value = try JSONSerialization.jsonObject(with: settings.line()) as! [String: Any]
    XCTAssertEqual(Set(value.keys), ["protocol", "kind", "requestId", "telemetry", "keepAwake"])
    XCTAssertEqual(value["telemetry"] as? Bool, true)
    XCTAssertEqual(value["keepAwake"] as? Bool, false)
    let name = HostCommand(kind: "name", name: "a\n\"b")
    let bytes = try name.line()
    XCTAssertEqual(bytes.filter { $0 == 10 }.count, 1)
    XCTAssertThrowsError(
      try HostCommand(kind: "name", name: String(repeating: "a", count: 5000)).line())
  }

  func testFlappingHostDoesNotGetUnlimitedRestarts() {
    var budget = RetryBudget()
    for attempt in 1...3 {
      budget.receivedSnapshot(now: Double(attempt))
      XCTAssertEqual(budget.nextDelay(), Double(attempt * 2))
    }
    XCTAssertNil(budget.nextDelay())
    budget.receivedSnapshot(now: 10)
    budget.receivedSnapshot(now: 310)
    XCTAssertEqual(budget.nextDelay(), 2)
  }
}
