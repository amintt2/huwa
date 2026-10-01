Pod::Spec.new do |s|
  s.name           = 'HuwaPasskey'
  s.version        = '0.1.0'
  s.summary        = 'Passkeys (largeBlob + PRF) carrying the Huwa recovery phrase'
  s.description    = 'ASAuthorization platform passkeys for huwa.mciut.fr: registration, largeBlob read/write and PRF, without any server.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'AuthenticationServices', 'CryptoKit'
end
