import ServiceManagement
import XCTest

@testable import RepeaterCore

final class LoginRegistrationTests: XCTestCase {
  @MainActor
  func testLeavingLoginOffDoesNotTouchAnAbsentService() async throws {
    for status: SMAppService.Status in [.notFound, .notRegistered] {
      try await LoginRegistration.apply(
        enabled: false, status: status,
        register: { XCTFail("Off must not register a login item") },
        unregister: { throw HostError.refused }
      )
    }
  }

  @MainActor
  func testDisablingAnExistingOrPendingRegistrationRemovesIt() async throws {
    for status: SMAppService.Status in [.enabled, .requiresApproval] {
      var removed = 0
      try await LoginRegistration.apply(
        enabled: false, status: status,
        register: { XCTFail("Off must not register a login item") },
        unregister: { removed += 1 }
      )
      XCTAssertEqual(removed, 1)
    }
  }

  @MainActor
  func testEnablingOnlyRegistersWhenNeeded() async throws {
    for status: SMAppService.Status in [.notFound, .notRegistered, .enabled, .requiresApproval] {
      var added = 0
      try await LoginRegistration.apply(
        enabled: true, status: status,
        register: { added += 1 },
        unregister: { XCTFail("On must not unregister a login item") }
      )
      XCTAssertEqual(added, status == .enabled || status == .requiresApproval ? 0 : 1)
    }
  }

  @MainActor
  func testFailedRemovalIsNotReportedAsSaved() async {
    do {
      try await LoginRegistration.apply(
        enabled: false, status: .enabled,
        register: {},
        unregister: { throw HostError.refused }
      )
      XCTFail("An existing registration's removal failure must reach the UI")
    } catch {
      XCTAssertTrue(error is HostError)
    }
  }
}
