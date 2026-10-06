#if HUWA_MPV
import Foundation
import Libmpv
import QuartzCore

protocol MpvCoreDelegate: AnyObject {
  func mpvLoaded(_ info: [String: Any])
  func mpvProgress(_ info: [String: Any])
  func mpvState(_ info: [String: Any])
  func mpvTracks(_ tracksJson: String)
  func mpvEnded()
  func mpvError(_ message: String)
}

/// Weak box handed to libmpv's wakeup callback, so a late callback never touches a freed core.
private final class WakeupBox {
  weak var core: MpvCore?
  init(_ core: MpvCore) { self.core = core }
}

/// One libmpv client. All mpv calls run on `queue`; delegate callbacks are delivered on main.
final class MpvCore {
  weak var delegate: MpvCoreDelegate?

  private var mpv: OpaquePointer?
  private let layer: CAMetalLayer
  private let queue = DispatchQueue(label: "app.huwa.mpv", qos: .userInitiated)
  private var box: Unmanaged<WakeupBox>?
  private var timer: DispatchSourceTimer?
  private var paused = true
  private var lastError = ""
  private var loaded = false

  init(layer: CAMetalLayer) {
    self.layer = layer
  }

  static func versionString() -> String {
    let v = mpv_client_api_version()
    return "libmpv client API \(v >> 16).\(v & 0xffff)"
  }

  func start() -> Bool {
    guard let ctx = mpv_create() else { return false }
    mpv = ctx

    // Rendering: gpu-next (libplacebo) on Vulkan through MoltenVK, drawing into our CAMetalLayer.
    var wid = Int64(Int(bitPattern: Unmanaged.passUnretained(layer).toOpaque()))
    mpv_set_option(ctx, "wid", MPV_FORMAT_INT64, &wid)
    let options: [(String, String)] = [
      ("vo", "gpu-next"),
      ("gpu-api", "vulkan"),
      ("gpu-context", "moltenvk"),
      // Hardware decoding (VideoToolbox) whenever the codec allows it, software otherwise.
      ("hwdec", "auto-safe"),
      // Battery: cheapest scalers, no dithering / peak detection / interpolation / debanding.
      ("profile", "fast"),
      ("video-rotate", "no"),
      // Bounded network cache (default would be 150 MiB forward + 50 MiB back).
      ("cache", "yes"),
      ("demuxer-max-bytes", "48MiB"),
      ("demuxer-max-back-bytes", "16MiB"),
      ("demuxer-readahead-secs", "20"),
      ("cache-pause-wait", "2"),
      ("network-timeout", "20"),
      // Keep the file open at EOF (eof-reached → JS "playToEnd"; seeking back still works).
      ("keep-open", "yes"),
      ("idle", "yes"),
      // Subtitles: ASS drawn by libass with its own styling; selection is driven from JS.
      ("sub-ass", "yes"),
      ("embeddedfonts", "yes"),
      // Zoom to fill (panscan): keep subtitles on the visible screen, not on the cropped edges.
      ("sub-use-margins", "yes"),
      ("sub-ass-force-margins", "yes"),
      ("sid", "no"),
      ("input-default-bindings", "no"),
      ("input-vo-keyboard", "no"),
      ("terminal", "no"),
      ("load-scripts", "no"),
      ("config", "no"),
    ]
    for (k, v) in options {
      let rc = mpv_set_option_string(ctx, k, v)
      if rc < 0 { NSLog("[HuwaMpv] option %@=%@: %@", k, v, String(cString: mpv_error_string(rc))) }
    }
    mpv_request_log_messages(ctx, "error")

    guard mpv_initialize(ctx) >= 0 else {
      mpv_terminate_destroy(ctx)
      mpv = nil
      return false
    }

    mpv_observe_property(ctx, 0, "pause", MPV_FORMAT_FLAG)
    mpv_observe_property(ctx, 0, "paused-for-cache", MPV_FORMAT_FLAG)
    mpv_observe_property(ctx, 0, "seeking", MPV_FORMAT_FLAG)
    mpv_observe_property(ctx, 0, "eof-reached", MPV_FORMAT_FLAG)
    mpv_observe_property(ctx, 0, "track-list", MPV_FORMAT_NODE)
    mpv_observe_property(ctx, 0, "duration", MPV_FORMAT_DOUBLE)

    let b = Unmanaged.passRetained(WakeupBox(self))
    box = b
    mpv_set_wakeup_callback(ctx, { raw in
      guard let raw else { return }
      let box = Unmanaged<WakeupBox>.fromOpaque(raw).takeUnretainedValue()
      box.core?.scheduleDrain()
    }, b.toOpaque())
    return true
  }

  /// mpv_terminate_destroy blocks until the core has shut down: runs on the queue, never on main.
  func destroy() {
    queue.async { [self] in
      stopTimer()
      guard let ctx = mpv else { return }
      mpv = nil
      mpv_set_wakeup_callback(ctx, nil, nil)
      mpv_terminate_destroy(ctx)
      box?.release()
      box = nil
    }
  }

  deinit {
    timer?.cancel()
    if let ctx = mpv {
      let b = box
      mpv_set_wakeup_callback(ctx, nil, nil)
      DispatchQueue.global(qos: .utility).async {
        mpv_terminate_destroy(ctx)
        b?.release()
      }
    }
  }

  // MARK: commands

  func load(url: String, headers: [String: String], start: Double, autoplay: Bool) {
    queue.async { [self] in
      guard let ctx = mpv else { return }
      loaded = false
      lastError = ""
      var fields: [String] = []
      for (k, v) in headers {
        if k.caseInsensitiveCompare("User-Agent") == .orderedSame {
          mpv_set_property_string(ctx, "user-agent", v)
        } else {
          fields.append("\(k): \(v)")
        }
      }
      runCommand(ctx, ["change-list", "http-header-fields", "clr", ""])
      for f in fields { runCommand(ctx, ["change-list", "http-header-fields", "append", f]) }
      mpv_set_property_string(ctx, "start", start > 1 ? String(format: "%.3f", start) : "none")
      mpv_set_property_string(ctx, "pause", autoplay ? "no" : "yes")
      mpv_set_property_string(ctx, "sid", "no")
      // The rotation nudge (refreshOutputSize) leaves an aspect override: never carry it to the next file.
      mpv_set_property_string(ctx, "video-aspect-override", "no")
      // Built-in torrent engine (loopback URL): a read may legitimately wait for a piece (swarm
      // hiccup, automatic re-announce after ~12–20 s without peers). 20 s would turn that wait
      // into a stream error; remote URLs keep the short timeout.
      let loopback = url.hasPrefix("http://127.0.0.1:")
      mpv_set_property_string(ctx, "network-timeout", loopback ? "120" : "20")
      runCommand(ctx, ["loadfile", url, "replace"])
    }
  }

  func setString(_ name: String, _ value: String) {
    queue.async { [self] in
      guard let ctx = mpv else { return }
      let rc = mpv_set_property_string(ctx, name, value)
      if rc < 0 { NSLog("[HuwaMpv] set %@=%@: %@", name, value, String(cString: mpv_error_string(rc))) }
    }
  }

  /// Makes mpv rebuild its video output at the layer's current size, without touching the
  /// decoder: MPVKit's moltenvk context only reads `drawableSize` when the VO is reconfigured,
  /// and a change of display aspect is the cheapest reconfigure. The override alternates
  /// between ±0.001 % of the real aspect (invisible) so every call is a real change.
  private var aspectNudge = false
  func refreshOutputSize() {
    queue.async { [self] in
      guard let ctx = mpv, let w = getDouble(ctx, "video-params/dw"), let h = getDouble(ctx, "video-params/dh"), w > 0, h > 0 else { return }
      aspectNudge.toggle()
      let aspect = (w / h) * (aspectNudge ? 1.00001 : 0.99999)
      mpv_set_property_string(ctx, "video-aspect-override", String(format: "%.6f", aspect))
    }
  }

  func command(_ args: [String]) {
    queue.async { [self] in
      guard let ctx = mpv else { return }
      runCommand(ctx, args)
    }
  }

  @discardableResult
  private func runCommand(_ ctx: OpaquePointer, _ args: [String]) -> Int32 {
    var cargs: [UnsafePointer<CChar>?] = args.map { UnsafePointer(strdup($0)) }
    cargs.append(nil)
    defer { for p in cargs where p != nil { free(UnsafeMutablePointer(mutating: p)) } }
    return mpv_command(ctx, &cargs)
  }

  // MARK: events

  fileprivate func scheduleDrain() {
    queue.async { [weak self] in self?.drain() }
  }

  private func drain() {
    while let ctx = mpv {
      guard let ev = mpv_wait_event(ctx, 0)?.pointee, ev.event_id != MPV_EVENT_NONE else { break }
      switch ev.event_id {
      case MPV_EVENT_FILE_LOADED:
        loaded = true
        let info: [String: Any] = [
          "duration": getDouble(ctx, "duration") ?? 0,
          "tracks": MpvCore.json(readTracks(ctx)),
          "videoCodec": getString(ctx, "current-tracks/video/codec") ?? "",
          "hwdec": getString(ctx, "hwdec-current") ?? "no",
        ]
        main { $0.mpvLoaded(info) }
        emitProgress(ctx)
      case MPV_EVENT_VIDEO_RECONFIG:
        // hwdec-current is only known once the decoder is up.
        let hw = getString(ctx, "hwdec-current") ?? "no"
        let codec = getString(ctx, "current-tracks/video/codec") ?? ""
        // Display size (after pixel aspect), for the subtitle overlay placement in JS.
        let w = getDouble(ctx, "video-params/dw") ?? 0
        let h = getDouble(ctx, "video-params/dh") ?? 0
        main { $0.mpvState(["hwdec": hw, "videoCodec": codec, "width": w, "height": h]) }
      case MPV_EVENT_END_FILE:
        if let data = ev.data {
          let end = data.assumingMemoryBound(to: mpv_event_end_file.self).pointee
          if end.reason == MPV_END_FILE_REASON_ERROR {
            let base = String(cString: mpv_error_string(end.error))
            let msg = lastError.isEmpty ? base : "\(base) — \(lastError)"
            main { $0.mpvError(msg) }
          }
        }
      case MPV_EVENT_LOG_MESSAGE:
        if let data = ev.data {
          let m = data.assumingMemoryBound(to: mpv_event_log_message.self).pointee
          if let t = m.text { lastError = String(cString: t).trimmingCharacters(in: .whitespacesAndNewlines) }
        }
      case MPV_EVENT_PROPERTY_CHANGE:
        guard let data = ev.data else { break }
        let prop = data.assumingMemoryBound(to: mpv_event_property.self).pointee
        handleProperty(ctx, String(cString: prop.name), prop)
      case MPV_EVENT_SHUTDOWN:
        return
      default:
        break
      }
    }
  }

  private func handleProperty(_ ctx: OpaquePointer, _ name: String, _ prop: mpv_event_property) {
    func flag() -> Bool? {
      guard prop.format == MPV_FORMAT_FLAG, let d = prop.data else { return nil }
      return d.assumingMemoryBound(to: Int32.self).pointee != 0
    }
    switch name {
    case "pause":
      guard let p = flag() else { return }
      paused = p
      if p { stopTimer() } else { startTimer() }
      emitProgress(ctx)
      main { $0.mpvState(["paused": p]) }
    case "paused-for-cache":
      guard let b = flag() else { return }
      main { $0.mpvState(["buffering": b]) }
    case "seeking":
      guard let s = flag() else { return }
      main { $0.mpvState(["seeking": s]) }
      if !s { emitProgress(ctx) }
    case "eof-reached":
      if flag() == true, loaded {
        emitProgress(ctx)
        main { $0.mpvEnded() }
      }
    case "duration":
      if prop.format == MPV_FORMAT_DOUBLE { emitProgress(ctx) }
    case "track-list":
      guard loaded else { return }
      let tracks = MpvCore.json(readTracks(ctx))
      main { $0.mpvTracks(tracks) }
    default:
      break
    }
  }

  // MARK: progress (4 Hz, only while playing; coalescing leeway for the CPU)

  private func startTimer() {
    guard timer == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + 0.25, repeating: 0.25, leeway: .milliseconds(60))
    t.setEventHandler { [weak self] in
      guard let self, let ctx = self.mpv else { return }
      self.emitProgress(ctx)
    }
    t.resume()
    timer = t
  }

  private func stopTimer() {
    timer?.cancel()
    timer = nil
  }

  private func emitProgress(_ ctx: OpaquePointer) {
    let pos = getDouble(ctx, "time-pos") ?? 0
    let info: [String: Any] = [
      "time": pos,
      "duration": getDouble(ctx, "duration") ?? 0,
      // demuxer-cache-time: absolute timestamp up to which data is buffered.
      "buffered": max(pos, getDouble(ctx, "demuxer-cache-time") ?? pos),
      "paused": paused,
    ]
    main { $0.mpvProgress(info) }
  }

  // MARK: property helpers (queue)

  private func getDouble(_ ctx: OpaquePointer, _ name: String) -> Double? {
    var v = 0.0
    return mpv_get_property(ctx, name, MPV_FORMAT_DOUBLE, &v) >= 0 ? v : nil
  }

  private func getString(_ ctx: OpaquePointer, _ name: String) -> String? {
    guard let c = mpv_get_property_string(ctx, name) else { return nil }
    defer { mpv_free(c) }
    return String(cString: c)
  }

  private func readTracks(_ ctx: OpaquePointer) -> [[String: Any]] {
    var node = mpv_node()
    guard mpv_get_property(ctx, "track-list", MPV_FORMAT_NODE, &node) >= 0 else { return [] }
    defer { mpv_free_node_contents(&node) }
    guard let list = MpvCore.convert(node) as? [[String: Any]] else { return [] }
    return list.compactMap { t in
      guard let id = t["id"] as? Int64, let type = t["type"] as? String else { return nil }
      return [
        "id": Int(id),
        "type": type,
        "title": t["title"] as? String ?? "",
        "lang": t["lang"] as? String ?? "",
        "codec": t["codec"] as? String ?? "",
        "default": t["default"] as? Bool ?? false,
        "forced": t["forced"] as? Bool ?? false,
        "selected": t["selected"] as? Bool ?? false,
        "external": t["external"] as? Bool ?? false,
      ]
    }
  }

  /// Tracks travel as JSON: nested arrays of dictionaries were not delivered reliably as event payloads.
  static func json(_ value: Any) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let s = String(data: data, encoding: .utf8) else { return "[]" }
    return s
  }

  static func convert(_ node: mpv_node) -> Any? {
    switch node.format {
    case MPV_FORMAT_STRING:
      return node.u.string.map { String(cString: $0) }
    case MPV_FORMAT_FLAG:
      return node.u.flag != 0
    case MPV_FORMAT_INT64:
      return node.u.int64
    case MPV_FORMAT_DOUBLE:
      return node.u.double_
    case MPV_FORMAT_NODE_ARRAY:
      guard let l = node.u.list?.pointee else { return [] }
      return (0..<Int(l.num)).compactMap { convert(l.values[$0]) }
    case MPV_FORMAT_NODE_MAP:
      guard let l = node.u.list?.pointee else { return [:] }
      var out: [String: Any] = [:]
      for i in 0..<Int(l.num) {
        guard let k = l.keys?[i] else { continue }
        out[String(cString: k)] = convert(l.values[i])
      }
      return out
    default:
      return nil
    }
  }

  private func main(_ f: @escaping (MpvCoreDelegate) -> Void) {
    DispatchQueue.main.async { [weak self] in
      if let d = self?.delegate { f(d) }
    }
  }
}
#endif
