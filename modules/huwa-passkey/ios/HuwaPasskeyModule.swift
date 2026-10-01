import AuthenticationServices
import CryptoKit
import ExpoModulesCore

// Passkeys for huwa.mciut.fr (no server). The passkey does not log in to anything: it gates a
// largeBlob that carries the recovery phrase (encrypted with the PRF output when available).
// Bytes cross the bridge as standard base64 strings. Errors are rejected with a short code:
//   cancelled · no-credentials · unsupported · not-associated · exists · busy · failed
// Requires the `webcredentials:huwa.mciut.fr` associated domain (plugins/with-passkeys.js) and
// https://huwa.mciut.fr/.well-known/apple-app-site-association listing the app.
private let relyingParty = "huwa.mciut.fr"

struct RegisterOptions: Record {
  @Field var userName: String = ""
  @Field var displayName: String?
  @Field var userId: String = ""
  @Field var challenge: String = ""
  @Field var prfSalt: String?
}

struct WriteBlobOptions: Record {
  @Field var credentialId: String = ""
  @Field var challenge: String = ""
  @Field var data: String = ""
}

struct AuthenticateOptions: Record {
  @Field var challenge: String = ""
  @Field var credentialId: String?
  @Field var readBlob: Bool = false
  @Field var prfSalt: String?
  /// Only credentials already on this device (no "other device" QR sheet); fails with no-credentials.
  @Field var immediate: Bool = false
}

public class HuwaPasskeyModule: Module {
  private var pending: PasskeyRequest?

  public func definition() -> ModuleDefinition {
    Name("HuwaPasskey")

    Function("isSupported") { () -> [String: Bool] in
      var largeBlob = false
      var prf = false
      if #available(iOS 17.0, *) { largeBlob = true }
      if #available(iOS 18.0, *) { prf = true }
      return ["passkeys": true, "largeBlob": largeBlob, "prf": prf]
    }

    AsyncFunction("register") { (o: RegisterOptions, promise: Promise) in
      guard #available(iOS 17.0, *) else { return promise.reject("unsupported", "iOS 17 requis") }
      guard let challenge = Data(base64Encoded: o.challenge), let userId = Data(base64Encoded: o.userId) else {
        return promise.reject("failed", "Paramètres invalides")
      }
      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
      let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: o.userName, userID: userId)
      if let display = o.displayName { request.displayName = display }
      // Preferred, not required: with `.supportRequired` a provider without largeBlob fails the whole
      // creation with an opaque error. We report support instead and the app explains it.
      request.largeBlob = .supportPreferred
      if #available(iOS 18.0, *) {
        if let salt = o.prfSalt.flatMap({ Data(base64Encoded: $0) }) {
          request.prf = .inputValues(.saltInput1(salt))
        } else {
          request.prf = .checkForSupport
        }
      }
      self.perform(request, immediate: false, promise: promise) { authorization in
        guard let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else { return nil }
        var out: [String: Any] = [
          "credentialId": reg.credentialID.base64EncodedString(),
          "attestationObject": reg.rawAttestationObject?.base64EncodedString() as Any,
          "largeBlob": reg.largeBlob?.isSupported ?? false,
          "prf": false,
        ]
        if #available(iOS 18.0, *), let prf = reg.prf {
          out["prf"] = prf.isSupported
          if let first = prf.first { out["prfFirst"] = Self.bytes(first).base64EncodedString() }
        }
        return out
      }
    }.runOnQueue(.main)

    AsyncFunction("writeBlob") { (o: WriteBlobOptions, promise: Promise) in
      guard #available(iOS 17.0, *) else { return promise.reject("unsupported", "iOS 17 requis") }
      guard let challenge = Data(base64Encoded: o.challenge), let id = Data(base64Encoded: o.credentialId), let data = Data(base64Encoded: o.data) else {
        return promise.reject("failed", "Paramètres invalides")
      }
      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
      let request = provider.createCredentialAssertionRequest(challenge: challenge)
      // largeBlob writes need exactly one allowed credential.
      request.allowedCredentials = [ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)]
      request.largeBlob = .write(data)
      self.perform(request, immediate: false, promise: promise) { authorization in
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { return nil }
        var written = false
        if case .write(let success)? = assertion.largeBlob?.result { written = success }
        return ["credentialId": assertion.credentialID.base64EncodedString(), "written": written]
      }
    }.runOnQueue(.main)

    AsyncFunction("authenticate") { (o: AuthenticateOptions, promise: Promise) in
      guard #available(iOS 17.0, *) else { return promise.reject("unsupported", "iOS 17 requis") }
      guard let challenge = Data(base64Encoded: o.challenge) else { return promise.reject("failed", "Paramètres invalides") }
      let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: relyingParty)
      let request = provider.createCredentialAssertionRequest(challenge: challenge)
      if let id = o.credentialId.flatMap({ Data(base64Encoded: $0) }) {
        request.allowedCredentials = [ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: id)]
      }
      if o.readBlob { request.largeBlob = .read }
      if #available(iOS 18.0, *), let salt = o.prfSalt.flatMap({ Data(base64Encoded: $0) }) {
        request.prf = .inputValues(.saltInput1(salt))
      }
      self.perform(request, immediate: o.immediate, promise: promise) { authorization in
        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { return nil }
        var out: [String: Any] = [
          "credentialId": assertion.credentialID.base64EncodedString(),
          "userHandle": assertion.userID.base64EncodedString(),
        ]
        if case .read(let data)? = assertion.largeBlob?.result, let data { out["blob"] = data.base64EncodedString() }
        if #available(iOS 18.0, *), let prf = assertion.prf {
          out["prfFirst"] = Self.bytes(prf.first).base64EncodedString()
        }
        return out
      }
    }.runOnQueue(.main)

    // Asks the password manager to drop a credential the app will never use (iOS 26+). Best effort.
    AsyncFunction("forget") { (credentialId: String) async -> Bool in
      guard let id = Data(base64Encoded: credentialId) else { return false }
      if #available(iOS 26.2, *) {
        return (try? await ASCredentialDataManager().reportUnknownPublicKeyCredential(relyingPartyIdentifier: relyingParty, credentialID: id)) != nil
      }
      if #available(iOS 26.0, *) {
        return (try? await ASCredentialUpdater().reportUnknownPublicKeyCredential(relyingPartyIdentifier: relyingParty, credentialID: id)) != nil
      }
      return false
    }

    // Keeps only `credentialId` for this user (older passkeys after "Recréer") and its shown name. iOS 26+.
    AsyncFunction("tidy") { (userId: String, credentialId: String, name: String?) async -> Bool in
      guard let user = Data(base64Encoded: userId), let id = Data(base64Encoded: credentialId) else { return false }
      if #available(iOS 26.2, *) {
        let manager = ASCredentialDataManager()
        try? await manager.reportAllAcceptedPublicKeyCredentials(relyingPartyIdentifier: relyingParty, userHandle: user, acceptedCredentialIDs: [id])
        if let name { try? await manager.reportPublicKeyCredentialUpdate(relyingPartyIdentifier: relyingParty, userHandle: user, newName: name) }
        return true
      }
      if #available(iOS 26.0, *) {
        let updater = ASCredentialUpdater()
        try? await updater.reportAllAcceptedPublicKeyCredentials(relyingPartyIdentifier: relyingParty, userHandle: user, acceptedCredentialIDs: [id])
        if let name { try? await updater.reportPublicKeyCredentialUpdate(relyingPartyIdentifier: relyingParty, userHandle: user, newName: name) }
        return true
      }
      return false
    }
  }

  private func perform(
    _ request: ASAuthorizationRequest,
    immediate: Bool,
    promise: Promise,
    map: @escaping (ASAuthorization) -> [String: Any]?
  ) {
    if let previous = pending {
      // A request whose controller never called back (sheet torn down without a delegate call)
      // must not block every later call: after a while, cancel it and go on.
      guard Date().timeIntervalSince(previous.startedAt) > Self.staleAfter else {
        return promise.reject("busy", "Une demande de clé d’accès est déjà en cours")
      }
      previous.abandon()
      pending = nil
    }
    let window = appContext?.utilities?.currentViewController()?.view.window ?? Self.keyWindow()
    let handler = PasskeyRequest(anchor: window) { [weak self] request, result in
      if self?.pending === request { self?.pending = nil }
      switch result {
      case .success(let authorization):
        if let value = map(authorization) { promise.resolve(value) } else { promise.reject("failed", "Réponse inattendue") }
      case .failure(let error):
        let (described, message) = Self.describe(error)
        var code = described
        // With .preferImmediatelyAvailableCredentials, "nothing on this device" comes back as a
        // cancel, without any sheet: report it as no-credentials so the app can offer the
        // other-device (QR) flow. A cancel after the sheet was shown stays a user cancel.
        if immediate, code == "cancelled", !request.presented || Date().timeIntervalSince(request.startedAt) < 1.0 {
          code = "no-credentials"
        }
        promise.reject(code, message)
      }
    }
    pending = handler
    let controller = ASAuthorizationController(authorizationRequests: [request])
    controller.delegate = handler
    controller.presentationContextProvider = handler
    handler.controller = controller
    if immediate {
      controller.performRequests(options: .preferImmediatelyAvailableCredentials)
    } else {
      controller.performRequests()
    }
  }

  /// A request still pending after this long is considered lost (the system sheet times out well before).
  private static let staleAfter: TimeInterval = 180

  private static func describe(_ error: Error) -> (String, String) {
    let ns = error as NSError
    let text = [ns.localizedDescription, ns.localizedFailureReason ?? ""].joined(separator: " ")
    guard ns.domain == ASAuthorizationError.errorDomain, let code = ASAuthorizationError.Code(rawValue: ns.code) else {
      return ("failed", text)
    }
    switch code {
    case .canceled:
      return ("cancelled", text)
    case .notInteractive:
      return ("no-credentials", text)
    case .failed where text.localizedCaseInsensitiveContains("associated"):
      // "Application with identifier … is not associated with domain huwa.mciut.fr"
      return ("not-associated", text)
    default:
      if #available(iOS 18.0, *), code == .matchedExcludedCredential { return ("exists", text) }
      return ("failed", text)
    }
  }

  private static func bytes(_ key: SymmetricKey) -> Data {
    key.withUnsafeBytes { Data($0) }
  }

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }
}

private final class PasskeyRequest: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
  let anchor: UIWindow?
  let done: (PasskeyRequest, Result<ASAuthorization, Error>) -> Void
  var controller: ASAuthorizationController?
  let startedAt = Date()
  /// The system asked where to show its sheet (UI was presented).
  private(set) var presented = false
  private var finished = false

  init(anchor: UIWindow?, done: @escaping (PasskeyRequest, Result<ASAuthorization, Error>) -> Void) {
    self.anchor = anchor
    self.done = done
  }

  func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
    presented = true
    return anchor ?? ASPresentationAnchor()
  }

  private func finish(_ result: Result<ASAuthorization, Error>) {
    guard !finished else { return }
    finished = true
    done(self, result)
    controller = nil
  }

  /// Settles a request the system never answered (its promise must not hang forever).
  func abandon() {
    controller?.cancel()
    finish(.failure(ASAuthorizationError(.canceled)))
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
    finish(.success(authorization))
  }

  func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
    finish(.failure(error))
  }
}
