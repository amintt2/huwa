import AVFoundation
import CoreMedia
import Foundation
import VideoToolbox

// Hardware HEVC re-encoding of a downloaded episode with AVAssetReader → AVAssetWriter.
// Kept free of UIKit / Expo so it also builds on macOS (the CLI used to measure real ratios).
//
//  - video: decoded to NV12, re-encoded HEVC Main (VideoToolbox, hardware) at `videoBitrate`,
//    same dimensions and orientation, keyframe every 4 s, B-frames on;
//  - audio: every track kept with its language. AAC sources are copied as is (no generation
//    loss); others are encoded to AAC at `audioBitrate`;
//  - subtitle / text / closed-caption tracks are passed through when the container accepts them.
// The output is written next to the input; the caller verifies it before replacing the original.

public struct TranscodeError: Error, LocalizedError {
  public let message: String
  public init(_ message: String) { self.message = message }
  public var errorDescription: String? { message }
}

public enum HuwaMedia {
  static func fourCC(_ code: FourCharCode) -> String {
    let bytes = [24, 16, 8, 0].map { UInt8((code >> UInt32($0)) & 0xFF) }
    return String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces).lowercased() ?? "?"
  }

  /// Duration, video size / codec / fps, track counts and file size.
  public static func probe(_ url: URL) async throws -> [String: Any] {
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration)
    var info: [String: Any] = ["durationSec": duration.seconds.isFinite ? duration.seconds : 0]
    let videos = try await asset.loadTracks(withMediaType: .video)
    if let v = videos.first {
      let (size, transform, fps, formats, rate) = try await v.load(.naturalSize, .preferredTransform, .nominalFrameRate, .formatDescriptions, .estimatedDataRate)
      let shown = size.applying(transform)
      info["width"] = Int(abs(shown.width))
      info["height"] = Int(abs(shown.height))
      info["fps"] = Double(fps)
      info["videoBitrate"] = Double(rate)
      if let f = formats.first { info["codec"] = fourCC(CMFormatDescriptionGetMediaSubType(f)) }
    }
    info["audioTracks"] = try await asset.loadTracks(withMediaType: .audio).count
    var subs = 0
    for type in [AVMediaType.subtitle, .text, .closedCaption] { subs += try await asset.loadTracks(withMediaType: type).count }
    info["subtitleTracks"] = subs
    info["readable"] = try await asset.load(.isReadable)
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
    info["sizeBytes"] = Double(size)
    return info
  }
}

public final class HuwaTranscoder: @unchecked Sendable {
  let input: URL
  let output: URL
  let videoBitrate: Int
  let audioBitrate: Int
  let onProgress: (Double) -> Void
  private var reader: AVAssetReader?
  private var writer: AVAssetWriter?
  private let lock = NSLock()
  private var cancelled = false

  public init(input: URL, output: URL, videoBitrate: Int, audioBitrate: Int, onProgress: @escaping (Double) -> Void) {
    self.input = input
    self.output = output
    self.videoBitrate = videoBitrate
    self.audioBitrate = audioBitrate
    self.onProgress = onProgress
  }

  public func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    reader?.cancelReading()
    writer?.cancelWriting()
  }

  private var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  /// Encodes, then returns the output's probe (duration, size…). Throws on failure / cancel.
  public func run() async throws -> [String: Any] {
    try? FileManager.default.removeItem(at: output)
    let asset = AVURLAsset(url: input)
    guard try await asset.load(.isReadable) else { throw TranscodeError("Format illisible par AVFoundation") }
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite, duration > 0 else { throw TranscodeError("Durée inconnue") }
    guard let video = try await asset.loadTracks(withMediaType: .video).first else { throw TranscodeError("Pas de piste vidéo") }

    let reader = try AVAssetReader(asset: asset)
    let ext = input.pathExtension.lowercased()
    let fileType: AVFileType = ext == "mov" ? .mov : .mp4
    let writer = try AVAssetWriter(outputURL: output, fileType: fileType)
    writer.shouldOptimizeForNetworkUse = false
    self.reader = reader
    self.writer = writer

    var pumps: [Pump] = []

    // ---- video ----
    let (size, transform, fps) = try await video.load(.naturalSize, .preferredTransform, .nominalFrameRate)
    let vOut = AVAssetReaderTrackOutput(track: video, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ])
    vOut.alwaysCopiesSampleData = false
    // HEVC wants even dimensions.
    let w = Int(size.width) & ~1
    let h = Int(size.height) & ~1
    var compression: [String: Any] = [
      AVVideoAverageBitRateKey: videoBitrate,
      AVVideoMaxKeyFrameIntervalDurationKey: 4,
      AVVideoAllowFrameReorderingKey: true,
      AVVideoProfileLevelKey: kVTProfileLevel_HEVC_Main_AutoLevel as String,
    ]
    if fps > 0 { compression[AVVideoExpectedSourceFrameRateKey] = Int(fps.rounded()) }
    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.hevc,
      AVVideoWidthKey: w,
      AVVideoHeightKey: h,
      AVVideoCompressionPropertiesKey: compression,
    ])
    vIn.transform = transform
    vIn.expectsMediaDataInRealTime = false
    guard reader.canAdd(vOut), writer.canAdd(vIn) else { throw TranscodeError("Encodeur HEVC indisponible") }
    reader.add(vOut)
    writer.add(vIn)
    pumps.append(Pump(name: "video", output: vOut, input: vIn, isVideo: true))

    // ---- audio: every track, AAC copied, others encoded ----
    for track in try await asset.loadTracks(withMediaType: .audio) {
      let (formats, lang, tag) = try await track.load(.formatDescriptions, .languageCode, .extendedLanguageTag)
      guard let fmt = formats.first else { continue }
      let isAAC = CMFormatDescriptionGetMediaSubType(fmt) == kAudioFormatMPEG4AAC
      let out: AVAssetReaderTrackOutput
      let inp: AVAssetWriterInput
      if isAAC {
        out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        inp = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: fmt)
      } else {
        let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt)?.pointee
        let channels = min(Int(asbd?.mChannelsPerFrame ?? 2), 2)
        let rate = asbd?.mSampleRate ?? 48000
        out = AVAssetReaderTrackOutput(track: track, outputSettings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVNumberOfChannelsKey: channels,
          AVSampleRateKey: rate,
        ])
        inp = AVAssetWriterInput(mediaType: .audio, outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVNumberOfChannelsKey: channels,
          AVSampleRateKey: rate,
          AVEncoderBitRateKey: audioBitrate,
        ])
      }
      out.alwaysCopiesSampleData = false
      inp.expectsMediaDataInRealTime = false
      if let lang { inp.languageCode = lang }
      if let tag { inp.extendedLanguageTag = tag }
      guard reader.canAdd(out), writer.canAdd(inp) else { continue }
      reader.add(out)
      writer.add(inp)
      pumps.append(Pump(name: "audio", output: out, input: inp, isVideo: false))
    }

    // ---- subtitles: pass-through when the container takes them ----
    for type in [AVMediaType.subtitle, .text, .closedCaption] {
      for track in try await asset.loadTracks(withMediaType: type) {
        let (formats, lang) = try await track.load(.formatDescriptions, .languageCode)
        guard let fmt = formats.first else { continue }
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        let inp = AVAssetWriterInput(mediaType: type, outputSettings: nil, sourceFormatHint: fmt)
        if let lang { inp.languageCode = lang }
        guard reader.canAdd(out), writer.canAdd(inp) else { continue }
        reader.add(out)
        writer.add(inp)
        pumps.append(Pump(name: "subtitle", output: out, input: inp, isVideo: false))
      }
    }

    guard reader.startReading() else { throw TranscodeError(reader.error?.localizedDescription ?? "Lecture impossible") }
    guard writer.startWriting() else { throw TranscodeError(writer.error?.localizedDescription ?? "Écriture impossible") }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    var lastReport = -1.0
    for pump in pumps {
      group.enter()
      pump.run(isCancelled: { [weak self] in self?.isCancelled ?? true }, onTime: { [weak self] t in
        guard let self else { return }
        let p = min(max(t.seconds / duration, 0), 1)
        if p - lastReport >= 0.005 {
          lastReport = p
          self.onProgress(p)
        }
      }, done: { group.leave() })
    }
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in group.notify(queue: .global()) { c.resume() } }

    if isCancelled || reader.status == .cancelled {
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: output)
      throw TranscodeError("cancelled")
    }
    if reader.status == .failed {
      writer.cancelWriting()
      try? FileManager.default.removeItem(at: output)
      throw TranscodeError(reader.error?.localizedDescription ?? "Lecture interrompue")
    }
    await writer.finishWriting()
    guard writer.status == .completed else {
      try? FileManager.default.removeItem(at: output)
      throw TranscodeError(writer.error?.localizedDescription ?? "Écriture interrompue")
    }
    onProgress(1)
    return try await HuwaMedia.probe(output)
  }
}

/// Moves samples from one reader output to one writer input on its own queue.
final class Pump: @unchecked Sendable {
  let output: AVAssetReaderOutput
  let input: AVAssetWriterInput
  let isVideo: Bool
  let queue: DispatchQueue
  private var finished = false

  init(name: String, output: AVAssetReaderOutput, input: AVAssetWriterInput, isVideo: Bool) {
    self.output = output
    self.input = input
    self.isVideo = isVideo
    self.queue = DispatchQueue(label: "huwa.transcode.\(name).\(UUID().uuidString)")
  }

  func run(isCancelled: @escaping () -> Bool, onTime: @escaping (CMTime) -> Void, done: @escaping () -> Void) {
    let finish = { [self] in
      if finished { return }
      finished = true
      input.markAsFinished()
      done()
    }
    input.requestMediaDataWhenReady(on: queue) { [self] in
      while input.isReadyForMoreMediaData && !finished {
        if isCancelled() { return finish() }
        guard let sample = output.copyNextSampleBuffer() else { return finish() }
        if isVideo { onTime(CMSampleBufferGetPresentationTimeStamp(sample)) }
        if !input.append(sample) { return finish() }
      }
    }
  }
}
