package tv.mediamax.car

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.provider.MediaStore
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CommandButton
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture

/**
 * Android Auto entry point: a Media3 [MediaLibraryService] (declared in the app manifest by
 * plugins/withMediaMaxCar.js together with `automotive_app_desc.xml`).
 *
 * * Browse: every `onGetChildren` / search is answered by JS (`src/car/tree.ts`) through [CarBridge].
 * * Playback: the session's player is a [CarProxyPlayer]; playing an item or pressing a transport
 *   button is forwarded to JS, which drives the existing expo-audio queue (`src/state/music.tsx`).
 * * Buttons (media button preferences, shown by Android Auto as custom actions):
 *   - spoken audio: back 15 s / forward 30 s in the prev/next slots, plus a playback-speed button
 *     whose icon and label show the current speed (tapping cycles through the app's speeds);
 *   - music longer than LONG_TRACK_MS (`longTrack`): back 15 s / forward 30 s in the secondary /
 *     overflow slots, so previous/next track keep the main slots.
 * * Voice: Assistant "play …" requests reach [handlePlayRequest] with a search query and, when the
 *   Assistant understood more, MediaStore extras (focus = artist/album/song/playlist, artist, album),
 *   which are passed to JS as search hints.
 * * Notifications: expo-audio's own service already shows the phone's media notification and holds
 *   the foreground state, so this service never posts one ([onUpdateNotification] is a no-op). It is
 *   only bound by Android Auto and stops when Android Auto unbinds.
 */
@OptIn(UnstableApi::class)
class MediaMaxCarService : MediaLibraryService() {
  companion object {
    private const val SESSION_ID = "MediaMaxCarSession"
    private const val ROOT_ID = "root"
    private const val ACTION_SEEK_BACK = "tv.mediamax.car.SEEK_BACK"
    private const val ACTION_SEEK_FORWARD = "tv.mediamax.car.SEEK_FORWARD"
    private const val ACTION_SPEED = "tv.mediamax.car.SPEED"
    private const val MAX_CACHED_ITEMS = 2000
    private const val PLAY_SUPPRESS_MS = 2500L
    private val SEEK_BACK_COMMAND = SessionCommand(ACTION_SEEK_BACK, Bundle.EMPTY)
    private val SEEK_FORWARD_COMMAND = SessionCommand(ACTION_SEEK_FORWARD, Bundle.EMPTY)
    private val SPEED_COMMAND = SessionCommand(ACTION_SPEED, Bundle.EMPTY)

    /** Media3's speed icons, for the speeds that have one; others use the generic speed icon. */
    private fun speedIcon(rate: Double): Int =
      when {
        near(rate, 0.5) -> CommandButton.ICON_PLAYBACK_SPEED_0_5
        near(rate, 0.8) -> CommandButton.ICON_PLAYBACK_SPEED_0_8
        near(rate, 1.0) -> CommandButton.ICON_PLAYBACK_SPEED_1_0
        near(rate, 1.2) -> CommandButton.ICON_PLAYBACK_SPEED_1_2
        near(rate, 1.5) -> CommandButton.ICON_PLAYBACK_SPEED_1_5
        near(rate, 1.8) -> CommandButton.ICON_PLAYBACK_SPEED_1_8
        near(rate, 2.0) -> CommandButton.ICON_PLAYBACK_SPEED_2_0
        else -> CommandButton.ICON_PLAYBACK_SPEED
      }

    private fun near(a: Double, b: Double) = kotlin.math.abs(a - b) < 0.01

    /** "1.25×", "2×". */
    private fun speedLabel(rate: Double): String {
      val rounded = Math.round(rate * 100) / 100.0
      val text = if (rounded == Math.floor(rounded)) rounded.toLong().toString() else rounded.toString()
      return "$text\u00D7"
    }
  }

  private var session: MediaLibrarySession? = null
  private lateinit var player: CarProxyPlayer
  private val items = HashMap<String, MediaItem>()
  private val searchResults = HashMap<String, List<MediaItem>>()
  private val carControllers = HashSet<String>()
  /** What the current media button preferences were built for (rebuilt only when it changes). */
  private var buttonsKey: String? = null

  private val seekBackButton: CommandButton by lazy {
    CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
      .setDisplayName("Back 15 seconds")
      .setSessionCommand(SEEK_BACK_COMMAND)
      .setSlots(CommandButton.SLOT_BACK)
      .build()
  }

  private val seekForwardButton: CommandButton by lazy {
    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
      .setDisplayName("Forward 30 seconds")
      .setSessionCommand(SEEK_FORWARD_COMMAND)
      .setSlots(CommandButton.SLOT_FORWARD)
      .build()
  }

  // Long music: the same commands, but previous/next track keep SLOT_BACK / SLOT_FORWARD. Media3 UIs
  // use the secondary slots; legacy controllers (Android Auto) get them as custom actions (overflow),
  // shown next to the previous/next buttons.
  private val longSeekBackButton: CommandButton by lazy {
    CommandButton.Builder(CommandButton.ICON_SKIP_BACK_15)
      .setDisplayName("Back 15 seconds")
      .setSessionCommand(SEEK_BACK_COMMAND)
      .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  private val longSeekForwardButton: CommandButton by lazy {
    CommandButton.Builder(CommandButton.ICON_SKIP_FORWARD_30)
      .setDisplayName("Forward 30 seconds")
      .setSessionCommand(SEEK_FORWARD_COMMAND)
      .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
      .build()
  }

  /** Spoken audio: shows the current speed; tapping asks JS for the next of the app's speeds. */
  private fun speedButton(rate: Double): CommandButton =
    CommandButton.Builder(speedIcon(rate))
      .setDisplayName("Playback speed ${speedLabel(rate)}")
      .setSessionCommand(SPEED_COMMAND)
      .setSlots(CommandButton.SLOT_OVERFLOW)
      .build()

  override fun onCreate() {
    super.onCreate()
    player = CarProxyPlayer(Looper.getMainLooper()) { command, value ->
      CarBridge.emit("onCommand", mapOf("command" to command, "value" to value))
    }
    val builder = MediaLibrarySession.Builder(this, player, Callback()).setId(SESSION_ID)
    launchIntent()?.let { builder.setSessionActivity(it) }
    session = builder.build()
    CarBridge.service = this
    onNowPlayingChanged()
    onJsReadyChanged()
  }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  /** expo-audio's AudioControlsService owns the playback notification and the foreground state. */
  override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {}

  /** Not started, only bound: never pause the phone's playback when the app is swiped away. */
  override fun onTaskRemoved(rootIntent: Intent?) {}

  override fun onDestroy() {
    if (CarBridge.service === this) CarBridge.service = null
    if (carControllers.isNotEmpty()) {
      carControllers.clear()
      updateConnected()
    }
    session?.release()
    session = null
    player.release()
    super.onDestroy()
  }

  // region Calls from CarBridge (main thread)

  fun onJsReadyChanged() {
    val current = session ?: return
    if (CarBridge.jsReady) {
      current.setPlaybackException(null)
      current.notifyChildrenChanged(ROOT_ID, Int.MAX_VALUE, null)
    } else {
      current.setPlaybackException(notReadyException())
    }
  }

  fun onNowPlayingChanged() {
    val state = CarBridge.nowPlaying
    player.update(state, ArtworkProvider.contentUri(this, state?.artworkUrl))
    val key = buttonsKey(state)
    if (key != buttonsKey) {
      buttonsKey = key
      session?.setMediaButtonPreferences(buttons())
    }
  }

  fun invalidate(parentId: String?) {
    val current = session ?: return
    if (parentId == null || parentId == ROOT_ID) searchResults.clear()
    current.notifyChildrenChanged(parentId ?: ROOT_ID, Int.MAX_VALUE, null)
  }

  // endregion

  private fun buttonsKey(state: NowPlayingRecord?): String =
    when {
      state == null -> "none"
      state.spoken -> "spoken:${Math.round(state.rate * 100)}"
      state.longTrack -> "long"
      else -> "none"
    }

  private fun buttons(): List<CommandButton> {
    val state = CarBridge.nowPlaying ?: return emptyList()
    return when {
      state.spoken -> listOf(seekBackButton, seekForwardButton, speedButton(state.rate))
      state.longTrack -> listOf(longSeekBackButton, longSeekForwardButton)
      else -> emptyList()
    }
  }

  private fun launchIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** Shown by Android Auto while the React Native runtime is not running, with an "Open" action. */
  private fun notReadyException(): PlaybackException {
    val extras = Bundle()
    launchIntent()?.let {
      extras.putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT, "Open Kinora")
      extras.putParcelable(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT, it)
    }
    return PlaybackException(CarBridge.NOT_READY_MESSAGE, null, PlaybackException.ERROR_CODE_SETUP_REQUIRED, extras)
  }

  private fun notReadyError() = SessionError(SessionError.ERROR_SESSION_SETUP_REQUIRED, CarBridge.NOT_READY_MESSAGE)

  private fun isCarController(controller: MediaSession.ControllerInfo): Boolean =
    controller.packageName != packageName && controller.packageName != "com.android.systemui"

  private fun updateConnected() {
    val connected = carControllers.isNotEmpty()
    if (connected != CarBridge.connected) {
      CarBridge.connected = connected
      CarBridge.emit("onConnectionChange", mapOf("connected" to connected, "platform" to "androidauto"))
    }
  }

  private fun rootItem(): MediaItem = folder(ROOT_ID, "Kinora")

  private fun folder(id: String, title: String): MediaItem =
    MediaItem.Builder()
      .setMediaId(id)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(title)
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
          .build(),
      )
      .build()

  private fun toItems(nodes: List<CarNodeRecord>): List<MediaItem> {
    if (items.size > MAX_CACHED_ITEMS) items.clear()
    return nodes.map { node -> toMediaItem(node).also { items[node.id] = it } }
  }

  private fun toMediaItem(node: CarNodeRecord): MediaItem {
    val extras = Bundle()
    node.group?.let { extras.putString(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, it) }
    node.progress?.let { progress ->
      if (progress >= 0.97) {
        extras.putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_FULLY_PLAYED)
      } else if (progress > 0) {
        extras.putInt(MediaConstants.EXTRAS_KEY_COMPLETION_STATUS, MediaConstants.EXTRAS_VALUE_COMPLETION_STATUS_PARTIALLY_PLAYED)
        extras.putDouble(MediaConstants.EXTRAS_KEY_COMPLETION_PERCENTAGE, progress)
      }
    }
    val metadata = MediaMetadata.Builder()
      .setTitle(node.title)
      .setSubtitle(node.subtitle)
      .setArtist(node.subtitle)
      .setArtworkUri(ArtworkProvider.contentUri(this, node.artworkUrl))
      .setIsBrowsable(node.browsable)
      .setIsPlayable(node.playable)
      .setMediaType(mediaType(node))
      .setExtras(extras)
      .build()
    return MediaItem.Builder().setMediaId(node.id).setMediaMetadata(metadata).build()
  }

  private fun mediaType(node: CarNodeRecord): Int =
    when (node.mediaType) {
      "track" -> MediaMetadata.MEDIA_TYPE_MUSIC
      "album" -> MediaMetadata.MEDIA_TYPE_ALBUM
      "artist" -> MediaMetadata.MEDIA_TYPE_ARTIST
      "playlist" -> MediaMetadata.MEDIA_TYPE_PLAYLIST
      "audiobook" -> MediaMetadata.MEDIA_TYPE_AUDIO_BOOK
      "chapter" -> MediaMetadata.MEDIA_TYPE_AUDIO_BOOK_CHAPTER
      "podcast" -> MediaMetadata.MEDIA_TYPE_PODCAST
      "episode" -> MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE
      else -> if (node.browsable) MediaMetadata.MEDIA_TYPE_FOLDER_MIXED else MediaMetadata.MEDIA_TYPE_MIXED
    }

  private fun <T> slicePage(list: List<T>, page: Int, pageSize: Int): List<T> {
    if (pageSize <= 0 || pageSize == Int.MAX_VALUE) return list
    val from = page.toLong() * pageSize
    if (from >= list.size) return emptyList()
    val start = from.toInt()
    return list.subList(start, minOf(list.size, start + pageSize))
  }

  /** "Play this item" / "play from search" from Android Auto (also covers Assistant voice requests). */
  private fun handlePlayRequest(mediaItems: List<MediaItem>) {
    val first = mediaItems.firstOrNull() ?: return
    if (!CarBridge.jsReady) return
    val query = first.requestMetadata.searchQuery
    player.suppressPlayUntilMs = SystemClock.elapsedRealtime() + PLAY_SUPPRESS_MS
    if (query != null) {
      CarBridge.emit("onPlayFromSearch", searchPayload(query, first.requestMetadata.extras))
    } else if (first.mediaId.isNotEmpty() && first.mediaId != MediaItem.DEFAULT_MEDIA_ID) {
      CarBridge.emit("onPlay", mapOf("mediaId" to first.mediaId))
    }
  }

  /**
   * Assistant's structured voice search ("play the album Discovery by Daft Punk"): MediaStore extras
   * on the play-from-search request. The free-text query is always there; the rest are hints.
   */
  private fun searchPayload(query: String, extras: Bundle?): Map<String, Any?> {
    val type =
      when (extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS)) {
        MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE -> "artist"
        MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE -> "album"
        MediaStore.Audio.Media.ENTRY_CONTENT_TYPE -> "track"
        MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE -> "playlist"
        MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE -> "music"
        else -> null
      }
    return mapOf(
      "query" to query,
      "type" to type,
      "artist" to extras?.getString(MediaStore.EXTRA_MEDIA_ARTIST)?.takeIf { it.isNotBlank() },
      "album" to extras?.getString(MediaStore.EXTRA_MEDIA_ALBUM)?.takeIf { it.isNotBlank() },
      "source" to "assistant",
    )
  }

  private fun searchNodes(query: String, onResult: (List<MediaItem>?, String?) -> Unit) {
    CarBridge.request("onSearch", mapOf("query" to query)) { nodes, error ->
      if (nodes == null) {
        onResult(null, error)
      } else {
        val results = toItems(nodes)
        if (searchResults.size > 10) searchResults.clear()
        searchResults[query] = results
        onResult(results, null)
      }
    }
  }

  private inner class Callback : MediaLibrarySession.Callback {
    override fun onConnect(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
    ): MediaSession.ConnectionResult {
      val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
        .add(SEEK_BACK_COMMAND)
        .add(SEEK_FORWARD_COMMAND)
        .add(SPEED_COMMAND)
        .build()
      return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
        .setAvailableSessionCommands(sessionCommands)
        .setMediaButtonPreferences(buttons())
        .build()
    }

    override fun onPostConnect(session: MediaSession, controller: MediaSession.ControllerInfo) {
      if (isCarController(controller)) {
        carControllers.add("${controller.packageName}:${controller.uid}")
        updateConnected()
      }
    }

    override fun onDisconnected(session: MediaSession, controller: MediaSession.ControllerInfo) {
      if (isCarController(controller)) {
        carControllers.remove("${controller.packageName}:${controller.uid}")
        updateConnected()
      }
    }

    override fun onGetLibraryRoot(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      // System media resumption asks for a "recent" root; the phone notification is expo-audio's.
      if (params?.isRecent == true) {
        return Futures.immediateFuture(LibraryResult.ofError<MediaItem>(SessionError.ERROR_NOT_SUPPORTED))
      }
      val extras = Bundle().apply {
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
        putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
      }
      return Futures.immediateFuture(LibraryResult.ofItem(rootItem(), LibraryParams.Builder().setExtras(extras).build()))
    }

    override fun onGetItem(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      mediaId: String,
    ): ListenableFuture<LibraryResult<MediaItem>> {
      // Unknown ids (e.g. after a process restart) are reported as folders so subscriptions succeed;
      // their children are fetched from JS anyway.
      val item = if (mediaId == ROOT_ID) rootItem() else items[mediaId] ?: folder(mediaId, mediaId)
      return Futures.immediateFuture(LibraryResult.ofItem(item, null))
    }

    override fun onGetChildren(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      parentId: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      if (!CarBridge.jsReady) {
        return Futures.immediateFuture(LibraryResult.ofError<ImmutableList<MediaItem>>(notReadyError()))
      }
      val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
      CarBridge.request("onGetChildren", mapOf("parentId" to parentId)) { nodes, error ->
        if (nodes == null) {
          future.set(LibraryResult.ofError(SessionError(SessionError.ERROR_UNKNOWN, error ?: CarBridge.TIMEOUT_MESSAGE)))
        } else {
          future.set(LibraryResult.ofItemList(slicePage(toItems(nodes), page, pageSize), params))
        }
      }
      return future
    }

    override fun onSearch(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<Void>> {
      if (!CarBridge.jsReady) {
        return Futures.immediateFuture(LibraryResult.ofError<Void>(notReadyError()))
      }
      searchNodes(query) { results, _ ->
        session.notifySearchResultChanged(browser, query, results?.size ?: 0, params)
      }
      return Futures.immediateFuture(LibraryResult.ofVoid())
    }

    override fun onGetSearchResult(
      session: MediaLibrarySession,
      browser: MediaSession.ControllerInfo,
      query: String,
      page: Int,
      pageSize: Int,
      params: LibraryParams?,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
      searchResults[query]?.let {
        return Futures.immediateFuture(LibraryResult.ofItemList(slicePage(it, page, pageSize), params))
      }
      if (!CarBridge.jsReady) {
        return Futures.immediateFuture(LibraryResult.ofError<ImmutableList<MediaItem>>(notReadyError()))
      }
      val future = SettableFuture.create<LibraryResult<ImmutableList<MediaItem>>>()
      searchNodes(query) { results, error ->
        if (results == null) {
          future.set(LibraryResult.ofError(SessionError(SessionError.ERROR_UNKNOWN, error ?: CarBridge.TIMEOUT_MESSAGE)))
        } else {
          future.set(LibraryResult.ofItemList(slicePage(results, page, pageSize), params))
        }
      }
      return future
    }

    override fun onSetMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
      startIndex: Int,
      startPositionMs: Long,
    ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
      handlePlayRequest(mediaItems)
      return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(mediaItems, startIndex, startPositionMs))
    }

    override fun onAddMediaItems(
      mediaSession: MediaSession,
      controller: MediaSession.ControllerInfo,
      mediaItems: MutableList<MediaItem>,
    ): ListenableFuture<MutableList<MediaItem>> {
      handlePlayRequest(mediaItems)
      return Futures.immediateFuture(mediaItems)
    }

    override fun onCustomCommand(
      session: MediaSession,
      controller: MediaSession.ControllerInfo,
      customCommand: SessionCommand,
      args: Bundle,
    ): ListenableFuture<SessionResult> {
      if (customCommand.customAction == ACTION_SPEED) {
        // No value: JS moves to the next of the app's speeds and reports it back (new icon).
        CarBridge.emit("onCommand", mapOf("command" to "rate", "value" to null))
        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
      }
      val value = when (customCommand.customAction) {
        ACTION_SEEK_BACK -> -CarProxyPlayer.SEEK_BACK_MS.toDouble()
        ACTION_SEEK_FORWARD -> CarProxyPlayer.SEEK_FORWARD_MS.toDouble()
        else -> return Futures.immediateFuture(SessionResult(SessionError.ERROR_NOT_SUPPORTED))
      }
      CarBridge.emit("onCommand", mapOf("command" to "seekBy", "value" to value))
      return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
    }
  }
}
