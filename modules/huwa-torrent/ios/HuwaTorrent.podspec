require 'json'

# The Rust library is linked only when the build flag is on AND the xcframework exists:
#   HUWA_TORRENT=1 in the environment (pod install / EAS env), or
#   "huwa.torrent": "1" in ios/Podfile.properties.json (written by plugins/with-huwa-torrent.js).
# Otherwise the module compiles without it and `isAvailable()` returns false.
huwa_torrent_flag_enabled = lambda do
  return true if ENV['HUWA_TORRENT'] == '1'
  props_path = File.expand_path(File.join(__dir__, '..', '..', '..', 'ios', 'Podfile.properties.json'))
  return false unless File.exist?(props_path)
  begin
    JSON.parse(File.read(props_path))['huwa.torrent'] == '1'
  rescue StandardError
    false
  end
end

xcframework_rel = '../../../native/huwa-torrent-core/dist/HuwaTorrentCore.xcframework'
xcframework_abs = File.expand_path(File.join(__dir__, xcframework_rel))
flag_on = huwa_torrent_flag_enabled.call
link_rust = flag_on && File.directory?(xcframework_abs)

if flag_on && !link_rust
  Pod::UI.warn "[HuwaTorrent] HUWA_TORRENT=1 but #{xcframework_abs} is missing. Run scripts/build-torrent.sh ios. Building WITHOUT the torrent engine."
end

Pod::Spec.new do |s|
  s.name           = 'HuwaTorrent'
  s.version        = '0.1.0'
  s.summary        = 'Huwa native torrent engine (librqbit) bridge'
  s.description    = 'Expo module exposing the huwa-torrent-core Rust library (librqbit session + loopback Range server).'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/huwa-app/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'

  xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  if link_rust
    s.vendored_frameworks = xcframework_rel
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) HUWA_TORRENT'
    # Rust's std on iOS links against these.
    s.libraries = 'resolv', 'c++'
    s.frameworks = 'Security', 'SystemConfiguration', 'Network'
  else
    s.frameworks = 'Network'
  end

  s.pod_target_xcconfig = xcconfig
end
