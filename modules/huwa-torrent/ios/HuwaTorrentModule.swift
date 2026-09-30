import ExpoModulesCore
import Network

let torrentStatusEvent = "onTorrentStatus"

public class HuwaTorrentModule: Module {
  private let queue = DispatchQueue(label: "app.huwa.torrent", qos: .utility)
  private let pathMonitor = NWPathMonitor()
  private var onCellular = false
  private var pollTimer: DispatchSourceTimer?

  public func definition() -> ModuleDefinition {
    Name("HuwaTorrent")

    Events(torrentStatusEvent)

    Constant("nativeVersion") {
      TorrentBridge.version()
    }

    Function("isAvailable") {
      TorrentBridge.isLinked
    }

    Function("isOnCellular") {
      self.onCellular
    }

    Function("defaultDataDir") {
      TorrentBridge.defaultDataDir()
    }

    // Blocking calls run on the module's background queue (AsyncFunction default), never on main.
    AsyncFunction("initialize") { (configJson: String) throws -> String in
      try TorrentBridge.initialize(configJson)
    }

    AsyncFunction("call") { (method: String, argsJson: String) throws -> String in
      try TorrentBridge.call(method, argsJson)
    }

    AsyncFunction("shutdown") {
      TorrentBridge.shutdown()
    }

    OnCreate {
      self.pathMonitor.pathUpdateHandler = { [weak self] path in
        self?.onCellular = path.usesInterfaceType(.cellular) && !path.usesInterfaceType(.wifi) && !path.usesInterfaceType(.wiredEthernet)
      }
      self.pathMonitor.start(queue: self.queue)
    }

    OnStartObserving {
      self.startPolling()
    }

    OnStopObserving {
      self.stopPolling()
    }

    OnDestroy {
      self.stopPolling()
      self.pathMonitor.cancel()
      TorrentBridge.shutdown()
    }
  }

  /// Pushes the torrent list to JS once per second while someone listens.
  private func startPolling() {
    guard pollTimer == nil, TorrentBridge.isLinked else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self, TorrentBridge.isInitialized else { return }
      if let json = try? TorrentBridge.call("list", "{}") {
        self.sendEvent(torrentStatusEvent, ["json": json])
      }
    }
    timer.resume()
    pollTimer = timer
  }

  private func stopPolling() {
    pollTimer?.cancel()
    pollTimer = nil
  }
}
