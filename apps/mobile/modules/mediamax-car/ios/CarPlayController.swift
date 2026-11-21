import CarPlay
import UIKit

/// Builds the CarPlay audio UI from the browse tree that JS serves.
///
/// * Root: a `CPTabBarTemplate` whose tabs are the browsable children of `root` (Home, Music,
///   Audiobooks, Podcasts; CarPlay allows at most 4 tabs for audio apps).
/// * Selecting a browsable row asks JS for its children and pushes a `CPListTemplate`
///   (the hierarchy is capped at 5 templates, as Apple requires for audio apps).
/// * Selecting a playable row sends `onPlay` to JS, which starts the phone's queue, and shows the
///   shared `CPNowPlayingTemplate`. That template is filled by expo-audio's MPNowPlayingInfoCenter
///   metadata and MPRemoteCommandCenter handlers, so the phone, the lock screen and the car stay in sync.
/// * iOS 27 and later: a Search row on the Home tab opens a `CPSearchTemplate` (audio apps may only use
///   the search template from iOS 27).
@MainActor
final class CarPlayController: NSObject {
  static let shared = CarPlayController()

  private static let homeTabId = "tab:home"
  private static let queueId = "queue"
  /// Apple: audio apps are limited to a depth of 5 templates, including the root template.
  private static let maxDepth = 5
  private static let requestTimeoutNs: UInt64 = 20_000_000_000

  private var interfaceController: CPInterfaceController?
  private var jsReady = false
  private var pending: [String: (Result<[CarNode], CarError>) -> Void] = [:]
  private var sequence = 0
  private var nowPlaying: CarNowPlayingRecord?
  /// Which extra Now Playing buttons are shown ("spoken", "long", "none"); nil = not set up yet.
  private var nowPlayingButtons: String?
  private var observingNowPlaying = false
  /// A Siri "play …" request that arrived before JS was ready (cold launch by Siri).
  private var pendingPlayFromSearch: [String: Any?]?
  private let images = NSCache<NSString, UIImage>()

  // MARK: - Scene life cycle

  func connect(_ controller: CPInterfaceController) {
    interfaceController = controller
    CarEventEmitter.shared.setConnected(true)

    // iOS can show the shared Now Playing template on its own (CarPlay home screen, Now Playing
    // button), so configure it as soon as the scene connects.
    let template = CPNowPlayingTemplate.shared
    if !observingNowPlaying {
      template.add(self)
      observingNowPlaying = true
    }
    template.upNextTitle = "Up Next"
    template.isAlbumArtistButtonEnabled = false
    nowPlayingButtons = nil
    applyNowPlaying()

    if jsReady {
      loadRoot()
    } else {
      showMessage("Kinora is starting…")
    }
    CarEventEmitter.shared.emit("onConnectionChange", ["connected": true, "platform": "carplay"])
  }

  func disconnect() {
    interfaceController = nil
    CarEventEmitter.shared.setConnected(false)
    let callbacks = Array(pending.values)
    pending.removeAll()
    callbacks.forEach { $0(.failure(CarError(message: "Disconnected"))) }
    CarEventEmitter.shared.emit("onConnectionChange", ["connected": false, "platform": "carplay"])
  }

  // MARK: - Calls from JS

  func setReady(_ ready: Bool) {
    guard ready != jsReady else { return }
    jsReady = ready
    if ready, let search = pendingPlayFromSearch {
      pendingPlayFromSearch = nil
      CarEventEmitter.shared.emit("onPlayFromSearch", search)
    }
    guard interfaceController != nil else { return }
    if ready {
      loadRoot()
    } else {
      showMessage("Kinora is starting…")
    }
  }

  func resolve(requestId: String, nodes: [CarNode]?, error: String?) {
    if let nodes {
      finish(requestId, .success(nodes))
    } else {
      finish(requestId, .failure(CarError(message: error ?? "Something went wrong")))
    }
  }

  func updateNowPlaying(_ state: CarNowPlayingRecord?) {
    nowPlaying = state
    applyNowPlaying()
  }

  /// Siri (`SiriIntents.swift`): play a voice search now, or as soon as the JS bridge is ready.
  func playFromSearch(_ body: [String: Any?]) {
    if jsReady {
      CarEventEmitter.shared.emit("onPlayFromSearch", body)
    } else {
      pendingPlayFromSearch = body
      startReactNativeIfNeeded()
    }
  }

  func invalidate(_ parentId: String?) {
    guard let controller = interfaceController, jsReady else { return }
    guard let parentId, parentId != "root" else {
      loadRoot()
      return
    }
    var lists = controller.templates.compactMap { $0 as? CPListTemplate }
    if let tabBar = controller.rootTemplate as? CPTabBarTemplate {
      lists += tabBar.templates.compactMap { $0 as? CPListTemplate }
    }
    for list in lists where Self.parentId(of: list) == parentId {
      reload(list, parentId: parentId)
    }
  }

  // MARK: - Templates

  private func showMessage(_ message: String) {
    guard let controller = interfaceController else { return }
    let list = CPListTemplate(title: "Kinora", sections: [])
    list.emptyViewTitleVariants = [message]
    controller.setRootTemplate(list, animated: false, completion: nil)
  }

  private func loadRoot() {
    request("onGetChildren", ["parentId": "root"]) { [weak self] result in
      guard let self, let controller = self.interfaceController else { return }
      switch result {
      case .failure(let error):
        self.showMessage(error.message)
      case .success(let nodes):
        let tabs = Array(nodes.filter { $0.browsable }.prefix(CPTabBarTemplate.maximumTabCount))
        guard !tabs.isEmpty else {
          // Not signed in, no audio libraries…: show the message rows JS sent.
          let list = CPListTemplate(title: "Kinora", sections: self.sections(for: nodes, parentId: "root"))
          list.emptyViewTitleVariants = ["Nothing to play yet"]
          controller.setRootTemplate(list, animated: false, completion: nil)
          return
        }
        var templates: [CPTemplate] = []
        for tab in tabs {
          let list = CPListTemplate(title: tab.title, sections: [])
          list.tabTitle = tab.title
          list.tabImage = UIImage(systemName: tab.icon ?? "square.grid.2x2")
          list.emptyViewTitleVariants = ["Loading…"]
          list.userInfo = ["parentId": tab.id]
          templates.append(list)
          self.reload(list, parentId: tab.id)
        }
        controller.setRootTemplate(CPTabBarTemplate(templates: templates), animated: false, completion: nil)
      }
    }
  }

  private func reload(_ list: CPListTemplate, parentId: String) {
    request("onGetChildren", ["parentId": parentId]) { [weak self, weak list] result in
      guard let self, let list else { return }
      self.apply(result, to: list, parentId: parentId)
    }
  }

  private func apply(_ result: Result<[CarNode], CarError>, to list: CPListTemplate, parentId: String) {
    switch result {
    case .success(let nodes):
      list.emptyViewTitleVariants = ["Nothing here yet"]
      list.updateSections(sections(for: nodes, parentId: parentId))
    case .failure(let error):
      list.emptyViewTitleVariants = [error.message]
      list.updateSections(sections(for: [], parentId: parentId))
    }
  }

  private struct Group {
    var header: String?
    var items: [CPListItem]
    var mergeable: Bool
  }

  private func sections(for nodes: [CarNode], parentId: String) -> [CPListSection] {
    var limit = CPListTemplate.maximumItemCount
    var groups: [Group] = []
    if parentId == Self.homeTabId, #available(iOS 27.0, *) {
      groups.append(Group(header: nil, items: [searchItem()], mergeable: false))
      limit -= 1
    }
    for node in nodes.prefix(max(0, limit)) {
      let item = makeItem(node, selectable: true)
      if let last = groups.indices.last, groups[last].mergeable, groups[last].header == node.group {
        groups[last].items.append(item)
      } else {
        groups.append(Group(header: node.group, items: [item], mergeable: true))
      }
    }
    return groups.prefix(CPListTemplate.maximumSectionCount).map {
      CPListSection(items: $0.items, header: $0.header, sectionIndexTitle: nil)
    }
  }

  private func makeItem(_ node: CarNode, selectable: Bool) -> CPListItem {
    let item = CPListItem(
      text: node.title,
      detailText: node.subtitle,
      image: nil,
      accessoryImage: nil,
      accessoryType: node.browsable ? .disclosureIndicator : .none
    )
    item.userInfo = node
    if let progress = node.progress, progress > 0 {
      item.playbackProgress = CGFloat(min(progress, 1))
    }
    item.isPlaying = node.playing
    loadImage(node.artworkUrl) { [weak item] image in
      item?.setImage(image)
    }
    if selectable {
      item.handler = { [weak self] _, completion in
        Task { @MainActor in
          guard let self else {
            completion()
            return
          }
          self.select(node, completion: completion)
        }
      }
    }
    return item
  }

  private func searchItem() -> CPListItem {
    let item = CPListItem(
      text: "Search",
      detailText: nil,
      image: UIImage(systemName: "magnifyingglass"),
      accessoryImage: nil,
      accessoryType: .disclosureIndicator
    )
    item.handler = { [weak self] _, completion in
      Task { @MainActor in
        guard let self, let controller = self.interfaceController,
              controller.templates.count < Self.maxDepth else {
          completion()
          return
        }
        let search = CPSearchTemplate()
        search.delegate = self
        controller.pushTemplate(search, animated: true) { _, _ in completion() }
      }
    }
    return item
  }

  private func select(_ node: CarNode, completion: @escaping () -> Void) {
    guard let controller = interfaceController else {
      completion()
      return
    }
    if node.browsable {
      guard controller.templates.count < Self.maxDepth else {
        completion()
        return
      }
      // CarPlay shows a spinner on the row until `completion` runs.
      request("onGetChildren", ["parentId": node.id]) { [weak self] result in
        guard let self, let controller = self.interfaceController else {
          completion()
          return
        }
        let list = CPListTemplate(title: node.title, sections: [])
        list.userInfo = ["parentId": node.id]
        self.apply(result, to: list, parentId: node.id)
        controller.pushTemplate(list, animated: true) { _, _ in completion() }
      }
    } else if node.playable {
      CarEventEmitter.shared.emit("onPlay", ["mediaId": node.id])
      showNowPlaying(controller)
      completion()
    } else {
      completion()
    }
  }

  private func showNowPlaying(_ controller: CPInterfaceController) {
    let template = CPNowPlayingTemplate.shared
    if controller.topTemplate === template { return }
    if controller.templates.contains(where: { $0 === template }) {
      // e.g. a row of the Up Next list, which sits on top of Now Playing.
      controller.pop(to: template, animated: true, completion: nil)
    } else {
      controller.pushTemplate(template, animated: true, completion: nil)
    }
  }

  private func applyNowPlaying() {
    guard interfaceController != nil else { return }
    let template = CPNowPlayingTemplate.shared
    template.isUpNextButtonEnabled = (nowPlaying?.queueLength ?? 0) > 1
    let mode = nowPlaying?.spoken == true ? "spoken" : nowPlaying?.longTrack == true ? "long" : "none"
    if nowPlayingButtons != mode {
      nowPlayingButtons = mode
      template.updateNowPlayingButtons(Self.buttons(for: mode))
    }
  }

  /// Extra Now Playing buttons, under the system transport controls.
  /// * Spoken audio: a playback-speed button (JS cycles through the app's speeds). The system
  ///   controls already show ±15/30 s (expo-audio's skip commands).
  /// * Long music (mixes, live sets): back 15 s / forward 30 s, so the system controls keep
  ///   previous/next track.
  private static func buttons(for mode: String) -> [CPNowPlayingButton] {
    switch mode {
    case "spoken":
      return [CPNowPlayingPlaybackRateButton(handler: { _ in
        CarEventEmitter.shared.emit("onCommand", ["command": "rate"])
      })]
    case "long":
      return [
        skipButton(symbol: "gobackward.15", deltaMs: -15_000),
        skipButton(symbol: "goforward.30", deltaMs: 30_000),
      ]
    default:
      return []
    }
  }

  private static func skipButton(symbol: String, deltaMs: Double) -> CPNowPlayingButton {
    let image = UIImage(systemName: symbol) ?? UIImage(systemName: deltaMs < 0 ? "gobackward" : "goforward") ?? UIImage()
    return CPNowPlayingImageButton(image: image, handler: { _ in
      CarEventEmitter.shared.emit("onCommand", ["command": "seekBy", "value": deltaMs])
    })
  }

  // MARK: - Requests to JS

  private func request(
    _ event: String,
    _ payload: [String: Any?],
    completion: @escaping (Result<[CarNode], CarError>) -> Void
  ) {
    guard jsReady else {
      completion(.failure(CarError(message: "Kinora is starting…")))
      return
    }
    sequence += 1
    let requestId = "cp\(sequence)"
    pending[requestId] = completion
    var body = payload
    body["requestId"] = requestId
    CarEventEmitter.shared.emit(event, body)
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: Self.requestTimeoutNs)
      self?.finish(requestId, .failure(CarError(message: "Couldn't reach your media server")))
    }
  }

  private func finish(_ requestId: String, _ result: Result<[CarNode], CarError>) {
    pending.removeValue(forKey: requestId)?(result)
  }

  // MARK: - Helpers

  private static func parentId(of template: CPTemplate) -> String? {
    (template.userInfo as? [String: Any])?["parentId"] as? String
  }

  private func loadImage(_ urlString: String?, apply: @escaping @MainActor (UIImage) -> Void) {
    guard let urlString, let url = URL(string: urlString) else { return }
    let key = urlString as NSString
    if let cached = images.object(forKey: key) {
      apply(cached)
      return
    }
    Task { @MainActor [weak self] in
      guard let result = try? await URLSession.shared.data(from: url),
            let image = UIImage(data: result.0) else { return }
      self?.images.setObject(image, forKey: key)
      apply(image)
    }
  }
}

// MARK: - Up Next

extension CarPlayController: CPNowPlayingTemplateObserver {
  func nowPlayingTemplateUpNextButtonTapped(_ nowPlayingTemplate: CPNowPlayingTemplate) {
    guard interfaceController != nil else { return }
    // Only a list template may be pushed on top of Now Playing.
    request("onGetChildren", ["parentId": Self.queueId]) { [weak self] result in
      guard let self, let controller = self.interfaceController else { return }
      let list = CPListTemplate(title: "Up Next", sections: [])
      list.userInfo = ["parentId": Self.queueId]
      self.apply(result, to: list, parentId: Self.queueId)
      controller.pushTemplate(list, animated: true, completion: nil)
    }
  }
}

// MARK: - Search (iOS 27+ for audio apps)

extension CarPlayController: CPSearchTemplateDelegate {
  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    updatedSearchText searchText: String,
    completionHandler: @escaping ([CPListItem]) -> Void
  ) {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard query.count >= 2 else {
      completionHandler([])
      return
    }
    request("onSearch", ["query": query]) { [weak self] result in
      guard let self, case .success(let nodes) = result else {
        completionHandler([])
        return
      }
      completionHandler(nodes.prefix(CPListTemplate.maximumItemCount).map { self.makeItem($0, selectable: false) })
    }
  }

  func searchTemplate(
    _ searchTemplate: CPSearchTemplate,
    selectedResult item: CPListItem,
    completionHandler: @escaping () -> Void
  ) {
    guard let node = item.userInfo as? CarNode else {
      completionHandler()
      return
    }
    select(node, completion: completionHandler)
  }
}
