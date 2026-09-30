Pod::Spec.new do |s|
  s.name           = 'HuwaKeychain'
  s.version        = '0.1.0'
  s.summary        = 'iCloud Keychain storage for the Huwa recovery phrase'
  s.description    = 'Stores items with kSecAttrSynchronizable so iOS syncs them end-to-end encrypted through iCloud Keychain.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'Security'
end
