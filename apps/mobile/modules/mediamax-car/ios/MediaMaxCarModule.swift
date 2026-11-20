import ExpoModulesCore

/// JS bridge for CarPlay and Siri. See `CarPlayController` for the template logic,
/// `CarPlaySceneDelegate.swift` for the scene wiring added to Info.plist by plugins/withMediaMaxCar.js
/// and `SiriIntents.swift` for "Play … in MediaMax".
public class MediaMaxCarModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediaMaxCar")

    Events("onGetChildren", "onSearch", "onPlay", "onPlayFromSearch", "onCommand", "onConnectionChange")

    OnCreate {
      CarEventEmitter.shared.setModule(self)
    }

    OnDestroy {
      CarEventEmitter.shared.clearModule(ifSameAs: self)
      onMain { CarPlayController.shared.setReady(false) }
    }

    Function("isConnected") { () -> Bool in
      CarEventEmitter.shared.isConnected
    }

    Function("setReady") { (ready: Bool) in
      onMain { CarPlayController.shared.setReady(ready) }
    }

    Function("resolveChildren") { (requestId: String, nodes: [CarNode]?, error: String?) in
      onMain { CarPlayController.shared.resolve(requestId: requestId, nodes: nodes, error: error) }
    }

    Function("updateNowPlaying") { (state: CarNowPlayingRecord?) in
      onMain { CarPlayController.shared.updateNowPlaying(state) }
    }

    Function("invalidate") { (parentId: String?) in
      onMain { CarPlayController.shared.invalidate(parentId) }
    }

    Function("syncRemoteCommands") { (trackSkip: Bool) in
      CarRemoteCommands.shared.sync(trackSkip: trackSkip)
    }

    // Diagnostics. Also keeps the scene delegate classes (instantiated by UIKit from their Info.plist
    // names, never referenced in code) and the Siri handler (looked up by name from AppDelegate)
    // linked into the static framework.
    Function("sceneDelegateClasses") { () -> [String] in
      [NSStringFromClass(CarPlaySceneDelegate.self), NSStringFromClass(PhoneSceneDelegate.self), NSStringFromClass(MediaMaxSiri.self)]
    }
  }
}
