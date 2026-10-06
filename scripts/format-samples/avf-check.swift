// What AVFoundation (the framework behind AVPlayer / expo-video) makes of each sample:
// whether the asset is playable, the FourCC of each track, and whether a sample of each video /
// audio track actually decodes (AVAssetReader with decompression, as AVPlayer would).
//
//   swift scripts/format-samples/avf-check.swift scripts/format-samples/out/*.mp4 ...
//
// Runs on macOS: its AVFoundation has the same container and codec rules as iOS for what is
// checked here, except that macOS can decode a few more codecs in software (e.g. VP9 through
// VideoToolbox's supplemental decoders) and has no per-device hardware gaps (AV1 hardware decoding
// exists on A17 Pro / M3 and later only). Rows where the two may differ are flagged in README.md.
import AVFoundation
import Foundation

func fourcc(_ code: FourCharCode) -> String {
  let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }
  return String(bytes: bytes, encoding: .macOSRoman) ?? "\(code)"
}

func decodes(_ asset: AVAsset, _ track: AVAssetTrack) -> Bool {
  guard let reader = try? AVAssetReader(asset: asset) else { return false }
  let settings: [String: Any]? = track.mediaType == .video
    ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    : track.mediaType == .audio ? [AVFormatIDKey: kAudioFormatLinearPCM] : nil
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
  guard reader.canAdd(out) else { return false }
  reader.add(out)
  guard reader.startReading() else { return false }
  let ok = out.copyNextSampleBuffer() != nil
  reader.cancelReading()
  return ok
}

/// Audio + video streams ffprobe sees: AVFoundation silently leaves out tracks it cannot handle
/// (DTS or MP3 in MP4: the video plays without sound).
func ffprobeAV(_ path: String) -> Int? {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  p.arguments = ["ffprobe", "-v", "error", "-show_entries", "stream=index,codec_type", "-of", "csv=p=0", path]
  let pipe = Pipe()
  p.standardOutput = pipe
  guard (try? p.run()) != nil else { return nil }
  p.waitUntilExit()
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  // MPEG-TS lists each stream again under its program: count distinct indexes.
  return Set(out.split(separator: "\n").filter { $0.hasSuffix(",video") || $0.hasSuffix(",audio") }).count
}

func check(_ path: String) async -> String {
  let asset = AVURLAsset(url: URL(fileURLWithPath: path))
  do {
    let (playable, tracks) = try await asset.load(.isPlayable, .tracks)
    var parts: [String] = []
    var allDecode = true
    for t in tracks {
      let descs = (try? await t.load(.formatDescriptions)) ?? []
      let code = descs.first.map { fourcc(CMFormatDescriptionGetMediaSubType($0)) } ?? "?"
      let kind = t.mediaType == .video ? "v" : t.mediaType == .audio ? "a" : t.mediaType == .subtitle || t.mediaType == .text ? "s" : t.mediaType.rawValue
      var cell = "\(kind):\(code)"
      if t.mediaType == .video || t.mediaType == .audio {
        let ok = decodes(asset, t)
        allDecode = allDecode && ok
        cell += ok ? "" : "(no decode)"
      }
      parts.append(cell)
    }
    let seen = tracks.filter { $0.mediaType == .video || $0.mediaType == .audio }.count
    if let expected = ffprobeAV(path), expected > seen {
      allDecode = false
      parts.append("(\(expected - seen) track(s) hidden)")
    }
    let verdict = playable && allDecode && !tracks.isEmpty ? "ok" : playable && !tracks.isEmpty ? "DEGRADED" : "FAIL"
    return "\(verdict)\tplayable=\(playable)\t\(parts.joined(separator: " "))"
  } catch {
    return "FAIL\t\(error.localizedDescription)"
  }
}

let files = CommandLine.arguments.dropFirst()
let sema = DispatchSemaphore(value: 0)
Task {
  for f in files {
    let r = await check(f)
    print("\((f as NSString).lastPathComponent)\t\(r)")
  }
  sema.signal()
}
sema.wait()
