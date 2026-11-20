package tv.mediamax.media

import android.content.Context
import android.view.KeyEvent
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler

/**
 * TV remote / HDMI-CEC / Bluetooth remote keys that react-native-tvos does not pass to JS (digits, colour keys,
 * Info, Guide, channel and track keys). They are reported to JS as `onRemoteKey` with W3C KeyboardEvent.key names
 * (the same names the web TV mode uses). The event is never consumed here, so React Native still sees every key.
 */
internal object RemoteKeys {
  @Volatile var listener: ((String) -> Unit)? = null

  private val NAMES = mapOf(
    KeyEvent.KEYCODE_CHANNEL_UP to "ChannelUp",
    KeyEvent.KEYCODE_CHANNEL_DOWN to "ChannelDown",
    KeyEvent.KEYCODE_MEDIA_NEXT to "MediaTrackNext",
    KeyEvent.KEYCODE_MEDIA_PREVIOUS to "MediaTrackPrevious",
    KeyEvent.KEYCODE_MEDIA_STOP to "MediaStop",
    KeyEvent.KEYCODE_PROG_RED to "ColorF0Red",
    KeyEvent.KEYCODE_PROG_GREEN to "ColorF1Green",
    KeyEvent.KEYCODE_PROG_YELLOW to "ColorF2Yellow",
    KeyEvent.KEYCODE_PROG_BLUE to "ColorF3Blue",
    KeyEvent.KEYCODE_INFO to "Info",
    KeyEvent.KEYCODE_GUIDE to "Guide",
    KeyEvent.KEYCODE_CAPTIONS to "ClosedCaptionToggle",
    KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK to "AudioTrack",
    KeyEvent.KEYCODE_TV_INPUT to "TV",
  )

  fun name(keyCode: Int): String? = when (keyCode) {
    in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> (keyCode - KeyEvent.KEYCODE_0).toString()
    in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> (keyCode - KeyEvent.KEYCODE_NUMPAD_0).toString()
    else -> NAMES[keyCode]
  }
}

class RemoteKeyHandler : ReactActivityHandler {
  override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
    RemoteKeys.name(keyCode)?.let { key -> RemoteKeys.listener?.invoke(key) }
    return false
  }
}

class MediaMaxMediaPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context?): List<ReactActivityHandler> = listOf(RemoteKeyHandler())
}
