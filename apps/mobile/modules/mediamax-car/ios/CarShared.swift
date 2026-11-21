import ExpoModulesCore
import MediaPlayer

/// A row of the browse tree, as sent by JS (`modules/mediamax-car/index.ts` > `CarNode`).
struct CarNode: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var subtitle: String? = nil
  @Field var artworkUrl: String? = nil
  /// SF Symbol name, used for tab icons.
  @Field var icon: String? = nil
  @Field var group: String? = nil
  @Field var browsable: Bool = false
  @Field var playable: Bool = false
  @Field var progress: Double? = nil
  @Field var playing: Bool = false
  /// Android Auto hint; unused on iOS.
  @Field var mediaType: String? = nil
}

/// Mirror of the phone player (`CarNowPlaying` in JS). On iOS the Now Playing screen itself is filled
/// by expo-audio through MPNowPlayingInfoCenter / MPRemoteCommandCenter; this only drives the extra
/// CarPlay buttons (Up Next, playback rate, ±15/30 s for long music tracks).
struct CarNowPlayingRecord: Record {
  @Field var id: String? = nil
  @Field var title: String = ""
  @Field var subtitle: String? = nil
  @Field var album: String? = nil
  @Field var artworkUrl: String? = nil
  @Field var durationMs: Double = 0
  @Field var positionMs: Double = 0
  @Field var playing: Bool = false
  @Field var buffering: Bool = false
  @Field var spoken: Bool = false
  /// Music longer than LONG_TRACK_MS (src/car/policy.ts): ±15/30 s as extra Now Playing buttons.
  @Field var longTrack: Bool = false
  @Field var rate: Double = 1
  @Field var hasNext: Bool = false
  @Field var hasPrevious: Bool = false
  @Field var queueLength: Int = 0
  @Field var error: String? = nil
}

struct CarError: Error {
  let message: String
}

/// Thread-safe route from native code to the JS module's events.
final class CarEventEmitter {
  static let shared = CarEventEmitter()

  private let lock = NSLock()
  private weak var module: Module?
  private var connected = false

  private init() {}

  func setModule(_ module: Module?) {
    lock.lock()
    self.module = module
    lock.unlock()
  }

  func clearModule(ifSameAs module: Module) {
    lock.lock()
    if self.module === module {
      self.module = nil
    }
    lock.unlock()
  }

  func emit(_ eventName: String, _ body: [String: Any?] = [:]) {
    lock.lock()
    let module = self.module
    lock.unlock()
    module?.sendEvent(eventName, body)
  }

  var isConnected: Bool {
    lock.lock()
    defer { lock.unlock() }
    return connected
  }

  func setConnected(_ value: Bool) {
    lock.lock()
    connected = value
    lock.unlock()
  }
}

/// Next / previous track for the CarPlay Now Playing screen (and the lock screen).
///
/// expo-audio drives MPRemoteCommandCenter for the current `AudioPlayer`, but a single player has no
/// queue, so it registers next/previous-track handlers that always fail and disables both commands
/// every time `setActiveForLockScreen` runs. The Kinora queue lives in JS (`src/state/music.tsx`),
/// so after each of those calls JS asks us to replace the handlers with ones that forward to JS.
/// Both calls dispatch to the main queue in call order, so ours always lands last.
///
/// Skip interval commands (±15/30 s) stay expo-audio's: enabled for spoken audio, disabled for music.
/// Long music tracks deliberately do not enable them: the lock screen, Control Centre and the CarPlay
/// main controls show skip *instead of* next/previous whenever skip is enabled, and AirPods / steering
/// wheel buttons would then skip 30 s instead of changing track. Their ±15/30 s live on extra CarPlay
/// Now Playing buttons (CarPlayController) and the phone's now-playing screen; Siri's "skip ahead /
/// go back N seconds" and the scrubber use changePlaybackPositionCommand, which expo-audio keeps on.
final class CarRemoteCommands {
  static let shared = CarRemoteCommands()

  private init() {}

  func sync(trackSkip: Bool) {
    DispatchQueue.main.async {
      let center = MPRemoteCommandCenter.shared()
      // nil removes every target, including expo-audio's always-failing ones.
      center.nextTrackCommand.removeTarget(nil)
      center.previousTrackCommand.removeTarget(nil)
      if trackSkip {
        _ = center.nextTrackCommand.addTarget { _ in
          CarEventEmitter.shared.emit("onCommand", ["command": "next"])
          return .success
        }
        _ = center.previousTrackCommand.addTarget { _ in
          CarEventEmitter.shared.emit("onCommand", ["command": "previous"])
          return .success
        }
      }
      center.nextTrackCommand.isEnabled = trackSkip
      center.previousTrackCommand.isEnabled = trackSkip
    }
  }
}

/// Runs `work` on the main actor (CarPlay objects are main-actor isolated).
func onMain(_ work: @escaping @MainActor () -> Void) {
  Task { @MainActor in
    work()
  }
}
