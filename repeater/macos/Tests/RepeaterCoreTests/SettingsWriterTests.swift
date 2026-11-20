import XCTest

@testable import RepeaterCore

final class SettingsWriterTests: XCTestCase {
  @MainActor
  func testChangesDuringASaveCoalesceWithoutOverlappingNativeCalls() async {
    var writes: [Int] = []
    var release: CheckedContinuation<Void, Never>?
    var states: [Bool] = []
    let writer = SettingsWriter<Int>(
      write: { value in
        writes.append(value)
        if value == 1 {
          await withCheckedContinuation { release = $0 }
        }
      },
      changed: { saving, _ in states.append(saving) }
    )
    writer.submit(1)
    for _ in 0..<100 {
      if release != nil { break }
      try? await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertNotNil(release)
    writer.submit(2)
    writer.submit(3)
    XCTAssertEqual(writes, [1])
    release?.resume()
    let saved = await writer.flush()
    XCTAssertTrue(saved)
    XCTAssertEqual(writes, [1, 3])
    XCTAssertEqual(states, [true, false])
  }

  @MainActor
  func testFlushReportsFailureAndAllowsRetry() async {
    var fail = true
    let writer = SettingsWriter<Int>(
      write: { _ in if fail { throw HostError.refused } },
      changed: { _, _ in }
    )
    writer.submit(1)
    let failed = await writer.flush()
    XCTAssertFalse(failed)
    fail = false
    writer.submit(1)
    let saved = await writer.flush()
    XCTAssertTrue(saved)
    XCTAssertNil(writer.error)
  }
}
