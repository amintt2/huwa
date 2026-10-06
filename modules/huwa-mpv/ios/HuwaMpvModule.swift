import ExpoModulesCore
import VideoToolbox

public class HuwaMpvModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HuwaMpv")

    /// True when libmpv is linked (Libmpv.xcframework present and HUWA_MPV not disabled at pod install).
    Function("isAvailable") { () -> Bool in
      MpvCapabilities.isLinked
    }

    /// Hardware decoders of THIS device (VideoToolbox). Used by the JS engine policy: e.g. AV1 goes
    /// to mpv (dav1d, software) only when there is no AV1 hardware decoder for AVPlayer to use.
    Function("hardwareDecoders") { () -> [String: Bool] in
      MpvCapabilities.hardwareDecoders()
    }

    Constant("mpvVersion") {
      MpvCapabilities.version
    }

    View(HuwaMpvView.self) {
      Events("onReady", "onLoaded", "onProgress", "onStateChange", "onTracks", "onEnd", "onMpvError")

      AsyncFunction("load") { (view: HuwaMpvView, url: String, headers: [String: String], start: Double, autoplay: Bool) in
        view.load(url: url, headers: headers, start: start, autoplay: autoplay)
      }
      AsyncFunction("setPaused") { (view: HuwaMpvView, paused: Bool) in
        view.setFlag("pause", paused)
      }
      AsyncFunction("seek") { (view: HuwaMpvView, seconds: Double) in
        view.seek(seconds)
      }
      AsyncFunction("setSpeed") { (view: HuwaMpvView, speed: Double) in
        view.setDouble("speed", speed)
      }
      AsyncFunction("setVolume") { (view: HuwaMpvView, volume: Double) in
        view.setDouble("volume", max(0, min(100, volume * 100)))
      }
      /// mpv track id, or -1 to disable (subtitles).
      AsyncFunction("setAudioTrack") { (view: HuwaMpvView, id: Int) in
        view.setString("aid", id < 0 ? "no" : String(id))
      }
      AsyncFunction("setSubtitleTrack") { (view: HuwaMpvView, id: Int) in
        view.setString("sid", id < 0 ? "no" : String(id))
      }
      /// Subtitle look / timing from the app's subtitle settings. Only `sub-…` options.
      AsyncFunction("setSubtitleOption") { (view: HuwaMpvView, name: String, value: String) in
        guard name.hasPrefix("sub-") else { return }
        view.setString(name, value)
      }
      /// Local subtitle file drawn by libass (styled ASS from an addon), selected at once. Applies
      /// to the current file only (mpv drops external tracks on the next load).
      AsyncFunction("addSubtitleFile") { (view: HuwaMpvView, path: String, title: String, lang: String) in
        view.command(["sub-add", path, "select", title, lang])
      }
      AsyncFunction("removeSubtitle") { (view: HuwaMpvView, id: Int) in
        view.command(["sub-remove", String(id)])
      }
      /// Zoom to fill the screen (crops top/bottom or sides) or back to the whole picture.
      AsyncFunction("setFill") { (view: HuwaMpvView, fill: Bool) in
        view.setString("panscan", fill ? "1.0" : "0.0")
      }
      AsyncFunction("stop") { (view: HuwaMpvView) in
        view.destroy()
      }
    }
  }
}

enum MpvCapabilities {
  static func hardwareDecoders() -> [String: Bool] {
    // FourCC literals: kCMVideoCodecType_AV1 / _VP9 constants are not declared on every SDK.
    let av1: CMVideoCodecType = 0x6176_3031 // 'av01'
    let vp9: CMVideoCodecType = 0x7670_3039 // 'vp09'
    return [
      "av1": VTIsHardwareDecodeSupported(av1),
      "hevc": VTIsHardwareDecodeSupported(kCMVideoCodecType_HEVC),
      "vp9": VTIsHardwareDecodeSupported(vp9),
      "h264": VTIsHardwareDecodeSupported(kCMVideoCodecType_H264),
    ]
  }

  #if HUWA_MPV
  static let isLinked = true
  #else
  static let isLinked = false
  #endif

  static var version: String {
    #if HUWA_MPV
    return MpvCore.versionString()
    #else
    return "unlinked"
    #endif
  }
}
