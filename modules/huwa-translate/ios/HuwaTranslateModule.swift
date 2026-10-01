import ExpoModulesCore
import Foundation
import SwiftUI
import UIKit
#if canImport(Translation)
import Translation
#endif

// On-device translation of subtitle lines with Apple's Translation framework. Nothing leaves the
// device: the models run locally (downloaded once through the system sheet).
//   - iOS 26+, model installed: `TranslationSession(installedSource:target:)`, no UI involved.
//   - iOS 18–25, or model to download: a hidden 1×1 SwiftUI view hosts `.translationTask`, the only
//     way to get a session there (and the system download prompt is presented from it).
//   - Below iOS 18: "unsupported".
// API (all async): isAvailable(source, target) → "installed" | "supported" | "unsupported",
// prepare(source, target) → same status after the system prompt, translateBatch(texts, source,
// target) → [String] in the order of `texts`.

public class HuwaTranslateModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuwaTranslate")

    AsyncFunction("isAvailable") { (source: String, target: String) async -> String in
      #if canImport(Translation)
      if #available(iOS 18.0, *) { return await TranslateCore.status(source, target) }
      #endif
      return "unsupported"
    }

    AsyncFunction("prepare") { (source: String, target: String) async throws -> String in
      #if canImport(Translation)
      if #available(iOS 18.0, *) {
        let before = await TranslateCore.status(source, target)
        if before != "supported" { return before }
        _ = try await TranslationHost.shared.run(source: source, target: target) { session in
          try await session.prepareTranslation()
          return [String]()
        }
        return await TranslateCore.status(source, target)
      }
      #endif
      return "unsupported"
    }

    AsyncFunction("translateBatch") { (texts: [String], source: String, target: String) async throws -> [String] in
      #if canImport(Translation)
      if #available(iOS 18.0, *) {
        if texts.isEmpty { return [] }
        return try await TranslateCore.translate(texts, source, target)
      }
      #endif
      throw TranslateUnsupported()
    }
  }
}

struct TranslateUnsupported: Error, LocalizedError {
  var errorDescription: String? { "Traduction sur l’appareil indisponible (iOS 18 requis)" }
}

struct TranslateTimeout: Error, LocalizedError {
  var errorDescription: String? { "La traduction sur l’appareil n’a pas démarré à temps" }
}

#if canImport(Translation)
@available(iOS 18.0, *)
enum TranslateCore {
  static func lang(_ id: String) -> Locale.Language { Locale.Language(identifier: id) }

  static func status(_ source: String, _ target: String) async -> String {
    switch await LanguageAvailability().status(from: lang(source), to: lang(target)) {
    case .installed: return "installed"
    case .supported: return "supported"
    case .unsupported: return "unsupported"
    @unknown default: return "unsupported"
    }
  }

  static func requests(_ texts: [String]) -> [TranslationSession.Request] {
    texts.enumerated().map { TranslationSession.Request(sourceText: $0.element, clientIdentifier: String($0.offset)) }
  }

  /// Responses back in request order (matched by `clientIdentifier`, untranslated → source text).
  static func ordered(_ texts: [String], _ responses: [TranslationSession.Response]) -> [String] {
    var out = texts
    for r in responses {
      if let id = r.clientIdentifier, let i = Int(id), i >= 0, i < out.count { out[i] = r.targetText }
    }
    return out
  }

  static func translate(_ texts: [String], _ source: String, _ target: String) async throws -> [String] {
    if #available(iOS 26.0, *), await status(source, target) == "installed" {
      let session = TranslationSession(installedSource: lang(source), target: lang(target))
      return ordered(texts, try await session.translations(from: requests(texts)))
    }
    let out = try await TranslationHost.shared.run(source: source, target: target) { session in
      ordered(texts, try await session.translations(from: requests(texts)))
    }
    return out
  }
}

/// Hidden SwiftUI host for `.translationTask`: queued jobs run inside the task closure (the session
/// it hands out is only valid there). One language pair at a time; a new pair swaps the configuration.
@available(iOS 18.0, *)
@MainActor
final class TranslationHost: ObservableObject {
  static let shared = TranslationHost()

  typealias Work = (TranslationSession) async throws -> [String]
  private struct Job {
    let id = UUID()
    let source: String
    let target: String
    let work: Work
    let done: CheckedContinuation<[String], Error>
  }

  @Published var configuration: TranslationSession.Configuration?
  private var jobs: [Job] = []
  private var draining = false
  private var controller: UIViewController?

  func run(source: String, target: String, work: @escaping Work) async throws -> [String] {
    guard attach() else { throw TranslateUnsupported() }
    return try await withCheckedThrowingContinuation { cont in
      let job = Job(source: source, target: target, work: work, done: cont)
      jobs.append(job)
      schedule()
      // The hidden host may never render (no window, app in background): a job still queued after
      // the timeout fails instead of leaving its caller waiting forever.
      Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: Self.queueTimeoutNs)
        self?.expire(job.id)
      }
    }
  }

  private static let queueTimeoutNs: UInt64 = 45 * 1_000_000_000

  private func expire(_ id: UUID) {
    guard let i = jobs.firstIndex(where: { $0.id == id }) else { return } // already running or done
    let job = jobs.remove(at: i)
    job.done.resume(throwing: TranslateTimeout())
  }

  private func schedule() {
    guard !draining, let next = jobs.first else { return }
    let src = TranslateCore.lang(next.source)
    let tgt = TranslateCore.lang(next.target)
    if configuration?.source == src, configuration?.target == tgt {
      configuration?.invalidate()
    } else {
      configuration = TranslationSession.Configuration(source: src, target: tgt)
    }
  }

  /// Called by the hosted view each time the configuration fires.
  func drain(_ session: TranslationSession) async {
    guard let cfg = configuration else { return }
    draining = true
    while let i = jobs.firstIndex(where: { TranslateCore.lang($0.source) == cfg.source && TranslateCore.lang($0.target) == cfg.target }) {
      let job = jobs.remove(at: i)
      do {
        job.done.resume(returning: try await job.work(session))
      } catch {
        job.done.resume(throwing: error)
      }
    }
    draining = false
    schedule()
  }

  private func attach() -> Bool {
    if let c = controller, c.view.window != nil { return true }
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first
    guard let root = window?.rootViewController else { return false }
    controller?.view.removeFromSuperview()
    controller?.removeFromParent()
    let host = UIHostingController(rootView: TranslationHostView(host: self))
    host.view.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
    host.view.backgroundColor = .clear
    host.view.alpha = 0.011
    host.view.isUserInteractionEnabled = false
    host.view.accessibilityElementsHidden = true
    root.addChild(host)
    root.view.addSubview(host.view)
    host.didMove(toParent: root)
    controller = host
    return true
  }
}

@available(iOS 18.0, *)
struct TranslationHostView: View {
  @ObservedObject var host: TranslationHost

  var body: some View {
    Color.clear
      .frame(width: 1, height: 1)
      .translationTask(host.configuration) { session in
        await host.drain(session)
      }
  }
}
#endif
