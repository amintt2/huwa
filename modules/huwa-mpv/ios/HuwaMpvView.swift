import AVFoundation
import ExpoModulesCore
import UIKit

/// CAMetalLayer that ignores the 1x1 drawable size MoltenVK sets to force a presentation
/// (flicker / stuck 1x1 drawable, see mpv-player/mpv#13651 and MPVKit's demo).
final class MpvMetalLayer: CAMetalLayer {
  override var drawableSize: CGSize {
    get { super.drawableSize }
    set {
      if Int(newValue.width) > 1 && Int(newValue.height) > 1 { super.drawableSize = newValue }
    }
  }
}

/// Native view owning one libmpv instance (vo=gpu-next on Vulkan/MoltenVK → Metal, VideoToolbox hwdec).
/// Everything mpv-related is in MpvCore; without HUWA_MPV this view is an inert black box.
public final class HuwaMpvView: ExpoView {
  let onLoaded = EventDispatcher()
  let onProgress = EventDispatcher()
  let onStateChange = EventDispatcher()
  let onTracks = EventDispatcher()
  let onEnd = EventDispatcher()
  let onMpvError = EventDispatcher()
  /// Sent once the view is in a window: from then on JS can call its functions (Fabric mounts
  /// the native view asynchronously, after the React ref is attached).
  let onReady = EventDispatcher()
  private var readySent = false

  let metalLayer = MpvMetalLayer()
  #if HUWA_MPV
  private var core: MpvCore?
  #endif

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    metalLayer.backgroundColor = UIColor.black.cgColor
    metalLayer.framebufferOnly = true
    metalLayer.contentsScale = UIScreen.main.nativeScale
    layer.addSublayer(metalLayer)

    let nc = NotificationCenter.default
    nc.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
    nc.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
    destroy()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && !readySent {
      readySent = true
      onReady([:])
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.frame = bounds
    // A CAMetalLayer that is a sublayer does not resize its drawable with its frame: without this,
    // after a rotation mpv keeps rendering at the old (landscape) size and the picture looks zoomed.
    let scale = metalLayer.contentsScale
    let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    if size.width > 1 && size.height > 1 && metalLayer.drawableSize != size {
      metalLayer.drawableSize = size
      scheduleVideoResize()
    }
    CATransaction.commit()
  }

  /// MPVKit's moltenvk render context never polls the layer size (its `control` answers
  /// VO_NOTIMPL to everything), so mpv keeps its swapchain at the old geometry and the picture
  /// stays in a corner after a rotation. MpvCore.refreshOutputSize forces a light VO
  /// reconfigure (no decoder restart) that re-reads drawableSize. Coalesced to one per frame.
  private var resizeWork: DispatchWorkItem?
  private func scheduleVideoResize() {
    #if HUWA_MPV
    guard core != nil else { return }
    resizeWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.core?.refreshOutputSize() }
    resizeWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.016, execute: work)
    #endif
  }

  // MARK: commands (from JS, main thread)

  func load(url: String, headers: [String: String], start: Double, autoplay: Bool) {
    #if HUWA_MPV
    if core == nil {
      let c = MpvCore(layer: metalLayer)
      c.delegate = self
      guard c.start() else {
        onMpvError(["message": "Impossible de démarrer mpv"])
        return
      }
      core = c
    }
    try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    try? AVAudioSession.sharedInstance().setActive(true)
    core?.load(url: url, headers: headers, start: start, autoplay: autoplay)
    #else
    onMpvError(["message": "mpv n'est pas inclus dans cette version de l'app"])
    #endif
  }

  func seek(_ seconds: Double) {
    #if HUWA_MPV
    core?.command(["seek", String(format: "%.3f", max(0, seconds)), "absolute"])
    #endif
  }

  func setFlag(_ name: String, _ value: Bool) {
    #if HUWA_MPV
    core?.setString(name, value ? "yes" : "no")
    #endif
  }

  func setDouble(_ name: String, _ value: Double) {
    #if HUWA_MPV
    core?.setString(name, String(format: "%.4f", value))
    #endif
  }

  func setString(_ name: String, _ value: String) {
    #if HUWA_MPV
    core?.setString(name, value)
    #endif
  }

  func command(_ args: [String]) {
    #if HUWA_MPV
    core?.command(args)
    #endif
  }

  func destroy() {
    #if HUWA_MPV
    core?.destroy()
    core = nil
    #endif
  }

  // MARK: battery: nothing is decoded or drawn in the background (no PiP with mpv).

  @objc private func didEnterBackground() {
    #if HUWA_MPV
    core?.setString("pause", "yes")
    core?.setString("vid", "no")
    #endif
  }

  @objc private func willEnterForeground() {
    #if HUWA_MPV
    // Stays paused: the user resumes from the controls.
    core?.setString("vid", "auto")
    #endif
  }
}

#if HUWA_MPV
extension HuwaMpvView: MpvCoreDelegate {
  func mpvLoaded(_ info: [String: Any]) { onLoaded(info) }
  func mpvProgress(_ info: [String: Any]) { onProgress(info) }
  func mpvState(_ info: [String: Any]) { onStateChange(info) }
  func mpvTracks(_ tracksJson: String) { onTracks(["tracks": tracksJson]) }
  func mpvEnded() { onEnd([:]) }
  func mpvError(_ message: String) { onMpvError(["message": message]) }
}
#endif
