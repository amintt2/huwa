require 'json'

# libmpv (MPVKit, LGPL build) is linked only when Libmpv.xcframework exists in THIS folder
# (CocoaPods ignores vendored paths outside the pod) and the flag is not turned off:
#   HUWA_MPV=0 in the environment (pod install / EAS env), or
#   "huwa.mpv": "0" in ios/Podfile.properties.json (written by plugins/with-huwa-mpv.js).
# Build the framework with scripts/fetch-mpvkit.sh. Without it the module still compiles,
# `isAvailable()` returns false and the app keeps AVPlayer only.
# A lambda, not `def`: CocoaPods evaluates podspecs inside the Pod module.
huwa_mpv_flag_enabled = lambda do
  return ENV['HUWA_MPV'] == '1' if ENV.key?('HUWA_MPV')
  props_path = File.expand_path(File.join(__dir__, '..', '..', '..', 'ios', 'Podfile.properties.json'))
  return true unless File.exist?(props_path)
  begin
    JSON.parse(File.read(props_path))['huwa.mpv'] != '0'
  rescue StandardError
    true
  end
end

xcframework_rel = 'Libmpv.xcframework'
xcframework_abs = File.expand_path(File.join(__dir__, xcframework_rel))
flag_on = huwa_mpv_flag_enabled.call
link_mpv = flag_on && File.directory?(xcframework_abs)

if flag_on && !link_mpv
  Pod::UI.warn "[HuwaMpv] #{xcframework_abs} is missing. Run scripts/fetch-mpvkit.sh. Building WITHOUT mpv (AVPlayer only)."
end

Pod::Spec.new do |s|
  s.name           = 'HuwaMpv'
  s.version        = '0.1.0'
  s.summary        = 'Huwa fallback video engine (libmpv via MPVKit, LGPL)'
  s.description    = 'Expo module exposing a libmpv-backed video view (gpu-next/MoltenVK, VideoToolbox hwdec, libass).'
  # This bridge is MIT; the vendored Libmpv.framework (libmpv + FFmpeg + deps) is LGPL, see ../README.md.
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/huwa-app/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }

  s.dependency 'ExpoModulesCore'

  s.source_files = '*.{h,m,swift}'
  s.frameworks = 'VideoToolbox', 'CoreMedia', 'QuartzCore', 'AVFoundation'

  xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  if link_mpv
    # Dynamic framework: embedded as Frameworks/Libmpv.framework (replaceable → LGPL relinking).
    s.vendored_frameworks = xcframework_rel
    s.preserve_paths = xcframework_rel
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) HUWA_MPV'
  end

  s.pod_target_xcconfig = xcconfig
end
