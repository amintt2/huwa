Pod::Spec.new do |s|
  s.name           = 'HuwaCookies'
  s.version        = '0.1.0'
  s.summary        = 'WKWebView cookie store access for Huwa'
  s.description    = 'Reads (including HttpOnly) and clears the cookies of WKWebsiteDataStore.default(), used after a Cloudflare check in a visible WebView.'
  s.license        = 'MIT'
  s.author         = 'Huwa'
  s.homepage       = 'https://github.com/amintt2/huwa'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
  s.frameworks = 'WebKit'
end
