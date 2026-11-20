import CarPlay
import Expo
import React
import UIKit
#if canImport(ExpoObjC)
import ExpoObjC
#endif

/// CarPlay scene delegate (Info.plist: `CPTemplateApplicationSceneSessionRoleApplication`,
/// class name `MediaMaxCarSceneDelegate`, written by plugins/withMediaMaxCar.js).
///
/// Expo SDK 58 runs under the UIKit scene life cycle: `ExpoAppSceneDelegate` creates the phone window
/// and starts React Native when the phone scene connects. CarPlay can launch the app with only the
/// CarPlay scene (phone locked in a pocket), so this delegate starts React Native itself in that case,
/// into a scene-less placeholder window stored on the app delegate. The whole React tree (session,
/// player, car bridge) then runs as usual; `PhoneSceneDelegate` adopts that window later instead of
/// mounting a second React root.
@objc(MediaMaxCarSceneDelegate)
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    startReactNativeIfNeeded()
    CarPlayController.shared.connect(interfaceController)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    CarPlayController.shared.disconnect()
  }
}

/// Starts React Native into a scene-less placeholder window when no scene has started it yet: a
/// CarPlay-first launch, or a background launch by Siri. `PhoneSceneDelegate` adopts the window later.
@MainActor
func startReactNativeIfNeeded() {
  guard let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
        provider.window == nil,
        let factory = provider.reactNativeFactory
  else {
    return
  }
  let placeholder = UIWindow(frame: UIScreen.main.bounds)
  provider.window = placeholder
  factory.startReactNative(
    withModuleName: provider.reactNativeFactoryModuleName,
    in: placeholder,
    initialProperties: nil,
    launchOptions: nil
  )
}

/// Phone scene delegate (Info.plist: `UIWindowSceneSessionRoleApplication`, class name
/// `MediaMaxPhoneSceneDelegate`). It replaces the template's `SceneDelegate`, which is a plain
/// `ExpoAppSceneDelegate` subclass: phone-first launches behave exactly the same. After a CarPlay-first
/// launch React Native already runs in the placeholder window, so the window is moved onto this scene
/// instead of starting React Native a second time.
@available(iOSApplicationExtension, unavailable)
@objc(MediaMaxPhoneSceneDelegate)
final class PhoneSceneDelegate: ExpoAppSceneDelegate {
  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let provider = UIApplication.shared.delegate as? ExpoReactNativeFactoryProvider,
          let existing = provider.window
    else {
      // Phone-first launch: Expo creates the window and starts React Native.
      super.scene(scene, willConnectTo: session, options: connectionOptions)
      return
    }

    existing.windowScene = windowScene
    window = existing
    existing.makeKeyAndVisible()

    // React Native is already running, so replay cold-start links and activities through the warm
    // scene APIs (which forward them to the app delegate subscribers and RCTLinkingManager).
    self.scene(scene, openURLContexts: connectionOptions.urlContexts)
    connectionOptions.userActivities.forEach { self.scene(scene, continue: $0) }
    if let shortcutItem = connectionOptions.shortcutItem {
      self.windowScene(windowScene, performActionFor: shortcutItem) { _ in }
    }
  }
}
