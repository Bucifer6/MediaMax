package tv.mediamax.car

import android.net.Uri
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture

/**
 * A [Player] that plays nothing: it mirrors the phone player (expo-audio, driven by
 * `src/state/music.tsx`) for Android Auto, and forwards every transport command to JS, which applies
 * it to the real queue. The phone's notification, lock screen and progress reporting therefore stay in
 * sync with the car.
 */
@OptIn(UnstableApi::class)
internal class CarProxyPlayer(
  looper: Looper,
  private val onCommand: (command: String, value: Double?) -> Unit,
) : SimpleBasePlayer(looper) {
  private var current: NowPlayingRecord? = null
  private var artworkUri: Uri? = null
  private var position: SimpleBasePlayer.PositionSupplier = SimpleBasePlayer.PositionSupplier.getConstant(0)

  /** Play/pause the car asked for, shown until JS reports the real state. */
  private var optimisticPlaying: Boolean? = null

  /**
   * Android Auto follows "play this item" with prepare() + play(). JS already starts the new queue
   * for the item, so that play() must not also toggle the player.
   */
  var suppressPlayUntilMs = 0L

  /** Main thread. */
  fun update(state: NowPlayingRecord?, artwork: Uri?) {
    current = state
    artworkUri = artwork
    optimisticPlaying = null
    // Created once per update, so the position extrapolates from the moment JS reported it.
    position =
      if (state != null && state.playing && !state.buffering) {
        SimpleBasePlayer.PositionSupplier.getExtrapolating(state.positionMs.toLong(), speedOf(state))
      } else {
        SimpleBasePlayer.PositionSupplier.getConstant(state?.positionMs?.toLong() ?: 0L)
      }
    invalidateState()
  }

  override fun getState(): SimpleBasePlayer.State {
    val builder = SimpleBasePlayer.State.Builder()
      .setAvailableCommands(COMMANDS)
      .setSeekBackIncrementMs(SEEK_BACK_MS)
      .setSeekForwardIncrementMs(SEEK_FORWARD_MS)
    val state = current
    val id = state?.id
    if (state == null || id.isNullOrEmpty()) {
      return builder
        .setPlaybackState(Player.STATE_IDLE)
        .setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        .build()
    }
    val metadata = MediaMetadata.Builder()
      .setTitle(state.title)
      .setArtist(state.subtitle)
      .setAlbumTitle(state.album)
      .setArtworkUri(artworkUri)
      .setIsBrowsable(false)
      .setIsPlayable(true)
      .setMediaType(if (state.spoken) MediaMetadata.MEDIA_TYPE_PODCAST_EPISODE else MediaMetadata.MEDIA_TYPE_MUSIC)
      .build()
    val item = MediaItem.Builder().setMediaId(id).setMediaMetadata(metadata).build()
    val durationUs = if (state.durationMs > 0) Util.msToUs(state.durationMs.toLong()) else C.TIME_UNSET
    val itemData = SimpleBasePlayer.MediaItemData.Builder(id)
      .setMediaItem(item)
      .setDurationUs(durationUs)
      .setIsSeekable(durationUs != C.TIME_UNSET)
      .build()
    return builder
      .setPlaylist(listOf(itemData))
      .setCurrentMediaItemIndex(0)
      .setPlaybackState(if (state.buffering) Player.STATE_BUFFERING else Player.STATE_READY)
      .setPlayWhenReady(optimisticPlaying ?: state.playing, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      .setContentPositionMs(position)
      .setPlaybackParameters(PlaybackParameters(speedOf(state)))
      .build()
  }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    if (playWhenReady && SystemClock.elapsedRealtime() < suppressPlayUntilMs) {
      return Futures.immediateVoidFuture()
    }
    if (current?.id != null) optimisticPlaying = playWhenReady
    onCommand(if (playWhenReady) "play" else "pause", null)
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleStop(): ListenableFuture<*> {
    onCommand("pause", null)
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

  /** The media session resolves the requested items itself (see MediaMaxCarService.onSetMediaItems). */
  override fun handleSetMediaItems(
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> onCommand("next", null)
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> onCommand("previous", null)
      Player.COMMAND_SEEK_BACK -> onCommand("seekBy", -SEEK_BACK_MS.toDouble())
      Player.COMMAND_SEEK_FORWARD -> onCommand("seekBy", SEEK_FORWARD_MS.toDouble())
      else -> if (positionMs != C.TIME_UNSET) onCommand("seekTo", positionMs.toDouble())
    }
    return Futures.immediateVoidFuture()
  }

  private fun speedOf(state: NowPlayingRecord): Float =
    if (state.spoken && state.rate > 0) state.rate.toFloat() else 1f

  companion object {
    const val SEEK_BACK_MS = 15_000L
    const val SEEK_FORWARD_MS = 30_000L

    private val COMMANDS: Player.Commands = Player.Commands.Builder()
      .addAll(
        Player.COMMAND_PLAY_PAUSE,
        Player.COMMAND_PREPARE,
        Player.COMMAND_STOP,
        Player.COMMAND_SEEK_TO_DEFAULT_POSITION,
        Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_PREVIOUS,
        Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
        Player.COMMAND_SEEK_TO_NEXT,
        Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
        Player.COMMAND_SEEK_BACK,
        Player.COMMAND_SEEK_FORWARD,
        Player.COMMAND_SET_MEDIA_ITEM,
        Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
        Player.COMMAND_GET_TIMELINE,
        Player.COMMAND_GET_METADATA,
        Player.COMMAND_RELEASE,
      )
      .build()
  }
}
