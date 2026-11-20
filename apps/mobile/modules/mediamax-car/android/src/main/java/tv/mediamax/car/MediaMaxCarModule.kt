package tv.mediamax.car

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** JS bridge for Android Auto. The car UI itself is served by [MediaMaxCarService]. */
class MediaMaxCarModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MediaMaxCar")

    Events("onGetChildren", "onSearch", "onPlay", "onPlayFromSearch", "onCommand", "onConnectionChange")

    OnCreate {
      CarBridge.attach(this@MediaMaxCarModule)
    }

    OnDestroy {
      CarBridge.detach(this@MediaMaxCarModule)
    }

    Function("isConnected") {
      CarBridge.connected
    }

    Function("setReady") { ready: Boolean ->
      CarBridge.setReady(ready)
    }

    Function("resolveChildren") { requestId: String, nodes: List<CarNodeRecord>?, error: String? ->
      CarBridge.resolve(requestId, nodes, error)
    }

    Function("updateNowPlaying") { state: NowPlayingRecord? ->
      CarBridge.updateNowPlaying(state)
    }

    Function("invalidate") { parentId: String? ->
      CarBridge.invalidate(parentId)
    }

    // iOS only (MPRemoteCommandCenter); Android Auto sends transport commands to MediaMaxCarService.
    Function("syncRemoteCommands") { _: Boolean -> }
  }
}
