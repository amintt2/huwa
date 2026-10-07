Pod::Spec.new do |s|
  s.name           = 'HuwaNetPath'
  s.version        = '0.1.0'
  s.summary        = 'Network path cost for Huwa'
  s.description    = 'Exposes NWPath isExpensive / isConstrained (Low Data Mode) and the interface types to JS.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'Network'
end
