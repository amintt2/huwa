import ExpoModulesCore
import Security

// Generic-password items marked kSecAttrSynchronizable: iOS copies them to the user's other
// devices through iCloud Keychain (end-to-end encrypted, only when iCloud Keychain is on).
// Synchronizable items cannot use a *ThisDeviceOnly accessibility, hence AfterFirstUnlock.
private let service = "app.huwa.cloud-backup"

final class KeychainException: GenericException<OSStatus> {
  override var reason: String { "Keychain error \(param)" }
}

public class HuwaKeychainModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuwaKeychain")

    // Update in place (never delete first: a failed add after a delete would lose the phrase,
    // and the deletion would propagate to the other devices through iCloud Keychain).
    AsyncFunction("set") { (key: String, value: String) in
      let base = Self.query(key)
      let attrs: [String: Any] = [
        kSecValueData as String: Data(value.utf8),
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
      ]
      var status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
      if status == errSecItemNotFound {
        var add = base
        add.merge(attrs) { _, new in new }
        status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
          // Created concurrently (iCloud sync): update it.
          status = SecItemUpdate(base as CFDictionary, attrs as CFDictionary)
        }
      }
      guard status == errSecSuccess else { throw KeychainException(status) }
    }

    AsyncFunction("get") { (key: String) -> String? in
      var q = Self.query(key)
      q[kSecReturnData as String] = true
      q[kSecMatchLimit as String] = kSecMatchLimitOne
      var out: AnyObject?
      let status = SecItemCopyMatching(q as CFDictionary, &out)
      if status == errSecItemNotFound { return nil }
      guard status == errSecSuccess, let data = out as? Data else { throw KeychainException(status) }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("remove") { (key: String) in
      let status = SecItemDelete(Self.query(key) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainException(status) }
    }

    // Keeps a file or directory out of iCloud / Finder device backups (the P2P worklet's store holds
    // this device's private keys: restored on another iPhone, it would clone this device's writers).
    AsyncFunction("excludeFromBackup") { (path: String) -> Bool in
      var url = URL(fileURLWithPath: path)
      guard FileManager.default.fileExists(atPath: path) else { return false }
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      try url.setResourceValues(values)
      return true
    }
  }

  private static func query(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
      kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
    ]
  }
}
