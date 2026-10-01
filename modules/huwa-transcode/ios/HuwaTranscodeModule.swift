import ExpoModulesCore
import Foundation
import UIKit

// "Compression intelligente" of downloaded episodes (see src/downloads/compress.ts for the
// decision). API:
//   probe(uri) → { durationSec, width, height, codec, fps, videoBitrate, audioTracks,
//                  subtitleTracks, sizeBytes, readable }
//   transcode(id, inputUri, outputUri, { videoBitrate, audioBitrate }) → probe of the output
//   cancel(id)
//   powerState() → { batteryLevel (0…1, -1 unknown), charging, lowPower }
//   events: onProgress { id, progress }
// A run asks iOS for background time; when that runs out (or the app is killed) the run is
// cancelled, the partial output deleted, and the JS side tries again later.

public class HuwaTranscodeModule: Module {
  private var running: [String: HuwaTranscoder] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("HuwaTranscode")
    Events("onProgress")

    AsyncFunction("probe") { (uri: String) async throws -> [String: Any] in
      try await HuwaMedia.probe(Self.url(uri))
    }

    AsyncFunction("transcode") { (id: String, inputUri: String, outputUri: String, options: [String: Any]) async throws -> [String: Any] in
      let video = (options["videoBitrate"] as? NSNumber)?.intValue ?? 2_200_000
      let audio = (options["audioBitrate"] as? NSNumber)?.intValue ?? 160_000
      let tc = HuwaTranscoder(input: Self.url(inputUri), output: Self.url(outputUri), videoBitrate: video, audioBitrate: audio) { [weak self] p in
        self?.sendEvent("onProgress", ["id": id, "progress": p])
      }
      self.set(id, tc)
      defer { self.set(id, nil) }
      let task = await Self.beginBackground(id) { tc.cancel() }
      defer { Task { await Self.endBackground(task) } }
      return try await tc.run()
    }

    Function("cancel") { (id: String) in
      self.get(id)?.cancel()
    }

    Function("powerState") { () -> [String: Any] in
      let device = UIDevice.current
      if !device.isBatteryMonitoringEnabled { device.isBatteryMonitoringEnabled = true }
      return [
        "batteryLevel": Double(device.batteryLevel),
        "charging": device.batteryState == .charging || device.batteryState == .full,
        "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
      ]
    }
  }

  private func set(_ id: String, _ tc: HuwaTranscoder?) {
    lock.lock()
    running[id] = tc
    lock.unlock()
  }

  private func get(_ id: String) -> HuwaTranscoder? {
    lock.lock()
    defer { lock.unlock() }
    return running[id]
  }

  static func url(_ uri: String) -> URL {
    if let u = URL(string: uri), u.isFileURL { return u }
    return URL(fileURLWithPath: uri)
  }

  @MainActor
  static func beginBackground(_ id: String, expired: @escaping () -> Void) -> UIBackgroundTaskIdentifier {
    var task: UIBackgroundTaskIdentifier = .invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "huwa.transcode.\(id)") {
      expired()
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    return task
  }

  @MainActor
  static func endBackground(_ task: UIBackgroundTaskIdentifier) {
    if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
  }
}
