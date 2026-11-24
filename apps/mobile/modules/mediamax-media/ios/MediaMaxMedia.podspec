Pod::Spec.new do |s|
  s.name           = 'MediaMaxMedia'
  s.version        = '1.0.0'
  s.summary        = 'Playback capability detection for Vibe'
  s.description    = 'Reports HDR10 / HLG / Dolby Vision playback support, hardware codecs and Apple TV display matching (AVDisplayCriteria).'
  s.author         = ''
  s.license        = 'MIT'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CoreMedia', 'VideoToolbox'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
