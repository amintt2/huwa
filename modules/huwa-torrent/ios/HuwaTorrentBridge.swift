import ExpoModulesCore
import Foundation

#if HUWA_TORRENT
// Module map shipped inside HuwaTorrentCore.xcframework (native/huwa-torrent-core/include).
import HuwaTorrentCore
#endif

final class TorrentUnavailableException: Exception {
  override var reason: String {
    "The torrent engine is not linked in this build (build with HUWA_TORRENT=1 after scripts/build-torrent.sh ios)"
  }
}

final class TorrentNativeException: GenericException<String> {
  override var reason: String {
    "Torrent engine returned an invalid response: \(param)"
  }
}

/// Wraps the C ABI (include/huwa_torrent.h). Every function returns the raw JSON envelope
/// produced by Rust (`{"ok":…}` / `{"error":"…"}`), parsed on the JS side.
enum TorrentBridge {
  static var isLinked: Bool {
    #if HUWA_TORRENT
    return true
    #else
    return false
    #endif
  }

  private static let lock = NSLock()
  private(set) static var isInitialized = false

  static func version() -> String {
    #if HUWA_TORRENT
    return String(cString: huwa_torrent_version())
    #else
    return "unlinked"
    #endif
  }

  static func initialize(_ configJson: String) throws -> String {
    #if HUWA_TORRENT
    lock.lock()
    defer { lock.unlock() }
    guard let raw = huwa_torrent_init(configJson) else {
      throw TorrentNativeException("null")
    }
    defer { huwa_torrent_string_free(raw) }
    let out = String(cString: raw)
    if out.contains("\"ok\"") {
      isInitialized = true
    }
    return out
    #else
    throw TorrentUnavailableException()
    #endif
  }

  static func call(_ method: String, _ argsJson: String) throws -> String {
    #if HUWA_TORRENT
    guard let raw = huwa_torrent_call(method, argsJson) else {
      throw TorrentNativeException("null")
    }
    defer { huwa_torrent_string_free(raw) }
    return String(cString: raw)
    #else
    throw TorrentUnavailableException()
    #endif
  }

  static func shutdown() {
    #if HUWA_TORRENT
    lock.lock()
    defer { lock.unlock() }
    huwa_torrent_shutdown()
    isInitialized = false
    #endif
  }

  /// Application Support/huwa-torrent, excluded from iCloud backups.
  static func defaultDataDir() -> String {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? FileManager.default.temporaryDirectory
    var dir = base.appendingPathComponent("huwa-torrent", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
    return dir.path
  }
}
