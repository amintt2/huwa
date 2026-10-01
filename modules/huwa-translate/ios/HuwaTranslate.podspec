Pod::Spec.new do |s|
  s.name           = 'HuwaTranslate'
  s.version        = '0.1.0'
  s.summary        = 'On-device subtitle translation (Apple Translation framework)'
  s.description    = 'Batch translation of subtitle lines with Apple Translation: iOS 26 installed-model sessions, a hidden SwiftUI translationTask host on iOS 18+ (and for model downloads).'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  # Weak: the app still launches on iOS 16/17, where the module reports "unsupported".
  s.weak_frameworks = 'Translation'
  s.frameworks = 'SwiftUI'
end
