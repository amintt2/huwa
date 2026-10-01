import AVFoundation
import ExpoModulesCore
import Foundation

// Offline HLS (.m3u8) episodes: a plain file download can't save a playlist and its segments,
// AVAssetDownloadURLSession does (background session, keeps going while the app is suspended,
// result is a `.movpkg` bundle AVPlayer plays offline).
// API:
//   isAvailable() → false on the simulator (AVAssetDownloadTask is device-only)
//   start(id, url, destPath, { headers?, title?, minBitrate? }) — destPath: absolute path of the
//     final `.movpkg` (moved there once complete)
//   pause(id) / resume(id) / cancel(id)
//   active() → [{ id, progress, state: "running" | "suspended" }] (tasks restored after relaunch)
//   events: onProgress { id, progress }, onDone { id, path }, onError { id, message }
// `minBitrate` (AVAssetDownloadTaskMinimumRequiredMediaBitrateKey) picks the variant: the lowest
// one at or above it, so the quality choice of the download maps to a bitrate.

public class HuwaHlsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuwaHls")
    Events("onProgress", "onDone", "onError")

    OnCreate {
      HlsDownloader.shared.emit = { [weak self] name, body in self?.sendEvent(name, body) }
      HlsDownloader.shared.wake()
    }

    Function("isAvailable") { () -> Bool in
      #if targetEnvironment(simulator)
      return false
      #else
      return true
      #endif
    }

    Function("start") { (id: String, url: String, destPath: String, options: [String: Any]) throws in
      guard let u = URL(string: url) else { throw HlsError("URL invalide") }
      let headers = options["headers"] as? [String: String]
      let title = options["title"] as? String ?? id
      let minBitrate = (options["minBitrate"] as? NSNumber)?.intValue
      try HlsDownloader.shared.start(id: id, url: u, dest: destPath, headers: headers, title: title, minBitrate: minBitrate)
    }

    Function("pause") { (id: String) in HlsDownloader.shared.task(id)?.suspend() }
    Function("resume") { (id: String) in HlsDownloader.shared.task(id)?.resume() }
    Function("cancel") { (id: String) in HlsDownloader.shared.cancel(id) }

    AsyncFunction("active") { () async -> [[String: Any]] in
      await HlsDownloader.shared.active()
    }
  }
}

struct HlsError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

final class HlsDownloader: NSObject, AVAssetDownloadDelegate, @unchecked Sendable {
  static let shared = HlsDownloader()
  static let destKey = "huwa.hls.destinations"

  var emit: ((String, [String: Any]) -> Void)?
  private let lock = NSLock()
  private var tasks: [String: AVAssetDownloadTask] = [:]
  private var progress: [String: Double] = [:]
  private var finished: [String: URL] = [:]

  private lazy var session: AVAssetDownloadURLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: "com.amintt2.huwa.hls")
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    return AVAssetDownloadURLSession(configuration: config, assetDownloadDelegate: self, delegateQueue: OperationQueue())
  }()

  /// Reconnects to tasks that kept running while the app was not.
  func wake() {
    session.getAllTasks { all in
      self.lock.lock()
      for t in all {
        if let t = t as? AVAssetDownloadTask, let id = t.taskDescription { self.tasks[id] = t }
      }
      self.lock.unlock()
    }
  }

  private var destinations: [String: String] {
    get { UserDefaults.standard.dictionary(forKey: Self.destKey) as? [String: String] ?? [:] }
    set { UserDefaults.standard.set(newValue, forKey: Self.destKey) }
  }

  func task(_ id: String) -> AVAssetDownloadTask? {
    lock.lock()
    defer { lock.unlock() }
    return tasks[id]
  }

  func start(id: String, url: URL, dest: String, headers: [String: String]?, title: String, minBitrate: Int?) throws {
    if let existing = task(id) {
      existing.resume()
      return
    }
    var assetOptions: [String: Any] = [:]
    // Not a public constant, but the documented-by-usage way to send headers with an HLS asset.
    if let headers, !headers.isEmpty { assetOptions["AVURLAssetHTTPHeaderFieldsKey"] = headers }
    let asset = AVURLAsset(url: url, options: assetOptions)
    var options: [String: Any] = [:]
    if let minBitrate { options[AVAssetDownloadTaskMinimumRequiredMediaBitrateKey] = minBitrate }
    guard let t = session.makeAssetDownloadTask(asset: asset, assetTitle: title, assetArtworkData: nil, options: options) else {
      throw HlsError("Téléchargement HLS impossible")
    }
    t.taskDescription = id
    var d = destinations
    d[id] = dest
    destinations = d
    lock.lock()
    tasks[id] = t
    progress[id] = 0
    lock.unlock()
    t.resume()
  }

  func cancel(_ id: String) {
    task(id)?.cancel()
    lock.lock()
    tasks[id] = nil
    lock.unlock()
  }

  func active() async -> [[String: Any]] {
    let all = await session.allTasks
    return all.compactMap { t in
      guard let t = t as? AVAssetDownloadTask, let id = t.taskDescription else { return nil }
      lock.lock()
      tasks[id] = t
      let p = progress[id] ?? 0
      lock.unlock()
      return ["id": id, "progress": p, "state": t.state == .suspended ? "suspended" : "running"]
    }
  }

  // MARK: AVAssetDownloadDelegate

  func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didLoad timeRange: CMTimeRange, totalTimeRangesLoaded loadedTimeRanges: [NSValue], timeRangeExpectedToLoad: CMTimeRange) {
    guard let id = assetDownloadTask.taskDescription else { return }
    let expected = timeRangeExpectedToLoad.duration.seconds
    guard expected > 0 else { return }
    let loaded = loadedTimeRanges.reduce(0.0) { $0 + $1.timeRangeValue.duration.seconds }
    let p = min(loaded / expected, 1)
    lock.lock()
    progress[id] = p
    lock.unlock()
    emit?("onProgress", ["id": id, "progress": p])
  }

  func urlSession(_ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didFinishDownloadingTo location: URL) {
    guard let id = assetDownloadTask.taskDescription else { return }
    lock.lock()
    finished[id] = location
    lock.unlock()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = task.taskDescription else { return }
    lock.lock()
    tasks[id] = nil
    let location = finished.removeValue(forKey: id)
    lock.unlock()
    var d = destinations
    let dest = d.removeValue(forKey: id)
    destinations = d

    if let error = error as NSError? {
      if error.code == NSURLErrorCancelled, error.domain == NSURLErrorDomain {
        if let location { try? FileManager.default.removeItem(at: location) }
        emit?("onError", ["id": id, "message": "cancelled"])
      } else {
        emit?("onError", ["id": id, "message": error.localizedDescription])
      }
      return
    }
    guard let location else {
      emit?("onError", ["id": id, "message": "Paquet HLS introuvable"])
      return
    }
    var final = location
    if let dest {
      let target = URL(fileURLWithPath: dest)
      do {
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: location, to: target)
        final = target
      } catch {
        // Kept where the system put it; the path is reported as is.
      }
    }
    emit?("onDone", ["id": id, "path": final.path])
  }
}
