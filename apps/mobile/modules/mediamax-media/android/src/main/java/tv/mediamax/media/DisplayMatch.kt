package tv.mediamax.media

import android.app.Activity
import android.os.Build
import android.view.Display
import kotlin.math.abs

/**
 * Android TV / Fire TV frame-rate matching: switch the HDMI output to a refresh rate that is the content's frame rate
 * (or a whole multiple of it) at the current resolution, via WindowManager.LayoutParams.preferredDisplayModeId. This
 * is the API Fire OS honours when "Match original frame rate" is on; Google TV / Android TV boxes switch directly.
 * Media3's own VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS stays on for seamless (VRR / same-rate) changes.
 */
internal object DisplayMatch {
  /** Picks the mode; null when the display has none that fits (then nothing changes). */
  fun pick(display: Display, fps: Double): Display.Mode? {
    if (fps < 10 || fps > 120 || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
    val current = display.mode
    val sameSize = display.supportedModes.filter { it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight }
    // Strict pass (23.976 ≠ 24), then loose (24 Hz for 23.976 beats 3:2 pulldown at 60 Hz).
    for (tolerance in doubleArrayOf(0.0005, 0.002)) {
      for (multiple in 1..5) {
        val target = fps * multiple
        if (target > 125) break
        sameSize.firstOrNull { abs(it.refreshRate - target) / target <= tolerance }?.let { return it }
      }
    }
    return null
  }

  fun match(activity: Activity, fps: Double): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
    val display = display(activity) ?: return false
    val mode = pick(display, fps) ?: return false
    activity.runOnUiThread {
      val window = activity.window ?: return@runOnUiThread
      val lp = window.attributes
      if (lp.preferredDisplayModeId != mode.modeId) {
        lp.preferredDisplayModeId = mode.modeId
        window.attributes = lp
      }
    }
    return true
  }

  fun reset(activity: Activity) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
    activity.runOnUiThread {
      val window = activity.window ?: return@runOnUiThread
      val lp = window.attributes
      if (lp.preferredDisplayModeId != 0) {
        lp.preferredDisplayModeId = 0
        window.attributes = lp
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun display(activity: Activity): Display? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display else activity.windowManager.defaultDisplay
}
