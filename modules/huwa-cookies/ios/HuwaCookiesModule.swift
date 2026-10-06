import ExpoModulesCore
import WebKit

// Cookies of the default WKWebView store, where react-native-webview (non-incognito) keeps the
// cookies of the Cloudflare verification page. HttpOnly cookies such as `cf_clearance` are not
// visible to the page's JavaScript: they can only be read here. Only cookies that domain-match
// the requested host are returned; nothing is ever written to the store.
public class HuwaCookiesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuwaCookies")

    AsyncFunction("getCookies") { (url: String, promise: Promise) in
      guard let host = URL(string: url)?.host?.lowercased(), !host.isEmpty else {
        promise.reject("ERR_URL", "URL invalide")
        return
      }
      DispatchQueue.main.async {
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
          let list: [[String: Any]] = cookies.filter { Self.matches(host: host, domain: $0.domain) }.map { c in
            var o: [String: Any] = [
              "name": c.name,
              "value": c.value,
              "domain": c.domain,
              "path": c.path,
              "secure": c.isSecure,
              "httpOnly": c.isHTTPOnly,
            ]
            if let d = c.expiresDate { o["expires"] = d.timeIntervalSince1970 * 1000 }
            return o
          }
          promise.resolve(list)
        }
      }
    }

    /// Deletes the cookies of a site (that domain and its subdomains); returns how many were removed.
    AsyncFunction("clearCookies") { (domain: String, promise: Promise) in
      let d = domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
      guard !d.isEmpty else {
        promise.resolve(0)
        return
      }
      DispatchQueue.main.async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { cookies in
          let gone = cookies.filter { Self.matches(host: $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")), domain: d) }
          let group = DispatchGroup()
          for c in gone {
            group.enter()
            store.delete(c) { group.leave() }
          }
          group.notify(queue: .main) { promise.resolve(gone.count) }
        }
      }
    }
  }

  /// `host` is the cookie's domain or one of its subdomains (RFC 6265 domain-match), or the
  /// cookie belongs to a subdomain of `host` (sources also fetch from `cdn.` / `api.` hosts).
  static func matches(host: String, domain: String) -> Bool {
    let d = domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
    if d.isEmpty { return false }
    return host == d || host.hasSuffix("." + d) || d.hasSuffix("." + host)
  }
}
