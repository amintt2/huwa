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

    AsyncFunction("set") { (key: String, value: String) in
      let base = Self.query(key)
      SecItemDelete(base as CFDictionary)
      var add = base
      add[kSecValueData as String] = Data(value.utf8)
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      let status = SecItemAdd(add as CFDictionary, nil)
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
