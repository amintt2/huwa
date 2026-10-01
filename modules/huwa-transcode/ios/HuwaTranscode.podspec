Pod::Spec.new do |s|
  s.name           = 'HuwaTranscode'
  s.version        = '0.1.0'
  s.summary        = 'Hardware HEVC re-encoding of downloaded episodes'
  s.description    = 'AVAssetReader → AVAssetWriter with the VideoToolbox HEVC encoder: target bitrate per resolution, AAC audio copied or encoded, subtitle tracks passed through, probe and power state helpers.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'VideoToolbox'
end
