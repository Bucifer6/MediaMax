import Intents

/// Siri "Play <something> in MediaMax" (`INPlayMediaIntent`), handled inside the app (iOS 14+ in-app
/// intent handling, no Intents extension).
///
/// Wiring (plugins/withMediaMaxCar.js):
/// * AppDelegate.swift gets `application(_:handlerFor:)`, which looks this class up by its Objective-C
///   name and asks it for a handler (so AppDelegate does not need to import this pod). Inert unless
///   the Info.plist lists the intent.
/// * With the `siri` plugin option (MEDIAMAX_SIRI=1): `INIntentsSupported: [INPlayMediaIntent]`,
///   `INSupportedMediaCategories`, `NSSiriUsageDescription` and the `com.apple.developer.siri`
///   entitlement (needs the Siri capability on the App ID / provisioning profile).
///
/// Siri resolves the request to a placeholder item built from its `INMediaSearch`; `handle` passes the
/// search (title, artist, album, media type) to JS as `onPlayFromSearch`, which searches the server and
/// plays the best match through the normal queue (src/car/CarBridge.tsx, src/car/tree.ts). If Siri
/// launched the app in the background, React Native is started and the request waits for the bridge.
/// Transport requests ("pause", "next song", "skip ahead 30 seconds") never come here: they go through
/// MPRemoteCommandCenter.
@objc(MediaMaxSiri)
public final class MediaMaxSiri: NSObject {
  /// `handlerFor:` — called from AppDelegate's `application(_:handlerFor:)`.
  @objc(handlerFor:)
  public static func handler(for intent: INIntent) -> Any? {
    intent is INPlayMediaIntent ? PlayMediaIntentHandler.shared : nil
  }
}

final class PlayMediaIntentHandler: NSObject, INPlayMediaIntentHandling {
  static let shared = PlayMediaIntentHandler()

  func resolveMediaItems(
    for intent: INPlayMediaIntent,
    with completion: @escaping ([INPlayMediaMediaItemResolutionResult]) -> Void
  ) {
    // The library lives on the user's server and is searched by JS when handling; resolve to a
    // placeholder so Siri goes on to `handle` instead of asking which item.
    let search = intent.mediaSearch
    let title = [search?.mediaName, search?.albumName, search?.artistName]
      .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first(where: { !$0.isEmpty }) ?? "MediaMax"
    let item = INMediaItem(identifier: "mediamax.search", title: title, type: search?.mediaType ?? .unknown, artwork: nil)
    completion(INPlayMediaMediaItemResolutionResult.successes(with: [item]))
  }

  func handle(intent: INPlayMediaIntent, completion: @escaping (INPlayMediaIntentResponse) -> Void) {
    let body = Self.payload(for: intent.mediaSearch)
    onMain {
      CarPlayController.shared.playFromSearch(body)
    }
    completion(INPlayMediaIntentResponse(code: .success, userActivity: nil))
  }

  /// `CarPlayFromSearch` in modules/mediamax-car/index.ts.
  static func payload(for search: INMediaSearch?) -> [String: Any?] {
    guard let search, search.reference != .currentlyPlaying else {
      // "Play MediaMax" / "resume": JS resumes the queue, or continues listening.
      return ["query": "", "source": "siri"]
    }
    return [
      "query": search.mediaName ?? "",
      "type": mediaType(search.mediaType),
      "artist": search.artistName,
      "album": search.albumName,
      "source": "siri",
    ]
  }

  private static func mediaType(_ type: INMediaItemType) -> String? {
    switch type {
    case .song: return "track"
    case .album: return "album"
    case .artist: return "artist"
    case .playlist: return "playlist"
    case .audioBook: return "audiobook"
    case .podcastShow, .podcastPlaylist, .podcastStation: return "podcast"
    case .podcastEpisode: return "episode"
    case .music, .genre: return "music"
    default: return nil
    }
  }
}
