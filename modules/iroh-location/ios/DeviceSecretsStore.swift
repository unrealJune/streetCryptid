import Foundation
import Security

/// This device's iroh identity, in a Keychain item we own.
///
/// The background drain path builds a node with no JS context alive, so it cannot be handed the
/// identity the way `createNode` is — it has to fetch it itself, through the Rust `DeviceSecrets`
/// port. This is the iOS half of that port.
///
/// # Why our own item rather than reading expo-secure-store's
///
/// `expo-secure-store` stores under service `"app"` with a `":auth"` / `":no-auth"` suffix rule and
/// its own account encoding. None of that is API — it is expo's internal convention, and a phone
/// whose identity became unreadable after an SDK bump would stop publishing with no error anywhere
/// that says why. Owning the item costs one write and removes that coupling entirely. Android has
/// the same reasoning and a much stronger version of it: there the format is an encrypted JSON
/// envelope we would have to reimplement.
///
/// # Why mirroring is safe here, and would not be for `seq`
///
/// The identity is written once and never changes, so two copies of it cannot diverge — the only
/// failure available is one copy missing, which reads as "not provisioned" and is handled. The
/// publish counter is the opposite (see `seq_store.rs`), which is why that one had to *move* rather
/// than be mirrored. So `expo-secure-store` keeps its copy for the mounted path, unchanged, and
/// this is a second reader for the background path.
///
/// # Accessibility
///
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, matching what the app already asks of
/// `expo-secure-store`. It is the weakest class that still works: a location callback arriving with
/// the phone locked in a pocket is the entire scenario, and `WhenUnlocked` would fail exactly then.
/// `ThisDeviceOnly` keeps it out of encrypted backups, so restoring an old backup cannot resurrect
/// an identity whose ratchet counters have moved on.
final class KeychainDeviceSecrets: DeviceSecrets {
  static let shared = KeychainDeviceSecrets()

  /// Ours, not expo's. Namespaced so it cannot collide with the app's other Keychain use.
  private static let service = "com.unrealjune.streetcryptid.device-identity"
  private static let identityAccount = "identity"
  private static let recvAccount = "recv"

  private init() {}

  // MARK: - DeviceSecrets (read side, called from Rust)

  /// `nil` means **not provisioned**, not an error: a fresh install has no identity until the app
  /// has run once. The Rust side treats that as "do nothing and wait" rather than minting one.
  func identitySecret() -> Data? {
    read(account: Self.identityAccount)
  }

  func recvSecret() -> Data? {
    read(account: Self.recvAccount)
  }

  // MARK: - Write side (called from JS, once, after `createNode`)

  /// Store both halves. Throws only on a genuine Keychain failure, never on "already there".
  ///
  /// Both are written or neither is: a node that has an identity but no receiving secret cannot
  /// open anything sent to it, and would look like a working device that silently drops every fix.
  func save(identity: Data, recv: Data) throws {
    try write(account: Self.identityAccount, value: identity)
    do {
      try write(account: Self.recvAccount, value: recv)
    } catch {
      // Roll the first one back so the pair stays all-or-nothing. A cleanup failure is not worth
      // masking the real error, so it is deliberately ignored.
      delete(account: Self.identityAccount)
      throw error
    }
  }

  /// Whether this device has already been seeded. Lets JS skip the write on every launch.
  func isProvisioned() -> Bool {
    identitySecret() != nil && recvSecret() != nil
  }

  // MARK: - Keychain

  private func query(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: account,
    ]
  }

  private func read(account: String) -> Data? {
    var query = self.query(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else {
      // `errSecItemNotFound` is the ordinary "not provisioned yet" case and stays quiet. Anything
      // else is worth a line, because the symptom — a phone that never publishes in the background
      // — otherwise looks identical to one that simply is not moving.
      if status != errSecItemNotFound {
        NSLog("[iroh-location] keychain read failed for \(account): OSStatus \(status)")
      }
      return nil
    }
    return item as? Data
  }

  private func write(account: String, value: Data) throws {
    // Delete-then-add rather than `SecItemUpdate`: an update leaves the ORIGINAL accessibility
    // class in place, so an item that ever landed under a stricter one would silently keep it and
    // fail to read in the background. Writing fresh pins the class every time.
    delete(account: account)

    var attributes = query(account: account)
    attributes[kSecValueData as String] = value
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw NSError(
        domain: "com.unrealjune.irohlocation.keychain",
        code: Int(status),
        userInfo: [NSLocalizedDescriptionKey: "keychain write failed for \(account)"])
    }
  }

  private func delete(account: String) {
    SecItemDelete(query(account: account) as CFDictionary)
  }
}
