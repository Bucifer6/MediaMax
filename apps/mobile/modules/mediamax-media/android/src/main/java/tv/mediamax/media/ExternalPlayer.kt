package tv.mediamax.media

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.Promise

/**
 * "Open in external player": hands a stream URL to VLC, Kodi, Just Player, MX Player, mpv … with ACTION_VIEW and
 * reads back the position where the player supports returning one.
 *
 * Extras by player (all documented intent APIs):
 *  - VLC (org.videolan.vlc): "title", "position" (Long ms), "from_start"; returns "extra_position" / "extra_duration".
 *  - MX Player, Just Player (MX-compatible), mpv-android: "title", "position" (Int ms), "return_result";
 *    return "position" / "duration" and MX/Just "end_by" ("user" | "playback_completion").
 *  - Kodi: plays the URL; returns nothing.
 */
internal object ExternalPlayer {
  const val REQUEST_CODE = 0x5642

  private var pending: Promise? = null
  private var launchedPackage: String? = null

  private const val VLC = "org.videolan.vlc"

  fun open(activity: Activity, options: Map<String, Any?>, promise: Promise) {
    val url = options["url"] as? String
    if (url.isNullOrBlank()) {
      promise.reject("ERR_EXTERNAL_PLAYER", "No stream URL", null)
      return
    }
    val title = options["title"] as? String
    val positionMs = (options["positionMs"] as? Number)?.toLong() ?: 0L
    val mimeType = (options["mimeType"] as? String)?.takeIf { it.isNotBlank() } ?: "video/*"
    val requested = (options["packageName"] as? String)?.takeIf { it.isNotBlank() }
    val pkg = requested?.takeIf { installed(activity, it) }

    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(Uri.parse(url), mimeType)
      if (pkg != null) setPackage(pkg)
      if (title != null) putExtra("title", title)
      if (pkg == VLC) {
        putExtra("position", positionMs)
        putExtra("from_start", positionMs <= 0)
      } else {
        putExtra("position", positionMs.coerceIn(0, Int.MAX_VALUE.toLong()).toInt())
        putExtra("return_result", true)
      }
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    // No player chosen (or it was uninstalled): let Android ask; "Always" there remembers the choice.
    val toStart = if (pkg == null) Intent.createChooser(intent, title ?: "Play with") else intent

    pending?.resolve(mapOf("launched" to true, "positionMs" to null))
    pending = promise
    launchedPackage = pkg
    try {
      activity.startActivityForResult(toStart, REQUEST_CODE)
    } catch (e: ActivityNotFoundException) {
      pending = null
      promise.resolve(mapOf("launched" to false, "reason" to "no-player", "requestedMissing" to (requested != null && pkg == null)))
    } catch (e: Exception) {
      pending = null
      promise.reject("ERR_EXTERNAL_PLAYER", e.message ?: "Could not open the player", e)
    }
  }

  fun onResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != REQUEST_CODE) return
    val promise = pending ?: return
    pending = null
    val extras = data?.extras
    fun num(vararg keys: String): Long? {
      for (k in keys) {
        @Suppress("DEPRECATION") val v = extras?.get(k)
        if (v is Number) return v.toLong()
      }
      return null
    }
    val position = num("extra_position", "position")?.takeIf { it >= 0 }
    val duration = num("extra_duration", "duration")?.takeIf { it > 0 }
    val endBy = extras?.getString("end_by")
    val completed = endBy == "playback_completion" || (position != null && duration != null && position >= duration - 1000)
    promise.resolve(
      mapOf(
        "launched" to true,
        "resultCode" to resultCode,
        "positionMs" to position,
        "durationMs" to duration,
        "completed" to completed,
        "packageName" to (launchedPackage ?: data?.component?.packageName),
      ),
    )
    launchedPackage = null
  }

  /** Which of the given packages are installed. */
  fun installedOf(activity: Activity?, packages: List<String>): List<String> {
    val ctx = activity ?: return emptyList()
    return packages.filter { installed(ctx, it) }
  }

  @Suppress("DEPRECATION")
  private fun installed(ctx: android.content.Context, pkg: String): Boolean {
    return try {
      if (Build.VERSION.SDK_INT >= 33) ctx.packageManager.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0))
      else ctx.packageManager.getPackageInfo(pkg, 0)
      true
    } catch (_: Exception) {
      false
    }
  }
}
