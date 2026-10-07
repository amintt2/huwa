import ExpoModulesCore
import Network

// What the current network path costs, as iOS sees it: `expensive` (cellular, or Wi-Fi through a
// phone's hotspot) and `constrained` (Low Data Mode). expo-network only tells Wi-Fi from cellular.
public class HuwaNetPathModule: Module {
  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "app.huwa.netpath", qos: .utility)
  private let lock = NSLock()
  private var last: [String: Any] = ["known": false]

  public func definition() -> ModuleDefinition {
    Name("HuwaNetPath")

    Events("onChange")

    Function("current") { () -> [String: Any] in
      self.lock.lock()
      defer { self.lock.unlock() }
      return self.last
    }

    OnCreate {
      self.monitor.pathUpdateHandler = { [weak self] path in
        guard let self else { return }
        let info: [String: Any] = [
          "known": true,
          "satisfied": path.status == .satisfied,
          "expensive": path.isExpensive,
          "constrained": path.isConstrained,
          "wifi": path.usesInterfaceType(.wifi),
          "cellular": path.usesInterfaceType(.cellular),
          "wired": path.usesInterfaceType(.wiredEthernet),
        ]
        self.lock.lock()
        self.last = info
        self.lock.unlock()
        self.sendEvent("onChange", info)
      }
      self.monitor.start(queue: self.queue)
    }

    OnDestroy {
      self.monitor.cancel()
    }
  }
}
