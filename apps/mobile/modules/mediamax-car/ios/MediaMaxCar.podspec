Pod::Spec.new do |s|
  s.name           = 'MediaMaxCar'
  s.version        = '1.0.0'
  s.summary        = 'CarPlay audio app support for Vibe'
  s.description    = 'CarPlay scene delegate, browse templates and Now Playing configuration driven from JavaScript.'
  s.author         = ''
  s.license        = 'MIT'
  s.homepage       = 'https://docs.expo.dev/modules/'
  # iOS only: CarPlay does not exist on tvOS, so Expo autolinking skips this pod for Apple TV targets.
  s.platforms      = {
    :ios => '16.4'
  }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # ExpoAppSceneDelegate / ExpoReactNativeFactoryProvider: the scene delegates start or adopt the
  # React Native window (CarPlay-first cold launch).
  s.dependency 'Expo'
  # Intents: Siri "Play … in Vibe" (INPlayMediaIntent, SiriIntents.swift).
  s.frameworks = 'CarPlay', 'MediaPlayer', 'Intents'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
