Pod::Spec.new do |s|
  s.name           = 'HuwaHls'
  s.version        = '0.1.0'
  s.summary        = 'Offline HLS downloads (AVAssetDownloadURLSession)'
  s.description    = 'Background AVAssetDownloadURLSession tasks for .m3u8 episodes: variant chosen by minimum bitrate, progress events, pause/resume/cancel, tasks restored after relaunch, .movpkg moved to the app documents.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'AVFoundation'
end
