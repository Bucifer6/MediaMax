package tv.mediamax.car

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileNotFoundException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/**
 * Serves server artwork to Android Auto as `content://` URIs: the car host cannot load http(s) URLs
 * for browse items. Only URLs this app handed out are served (no open proxy); files are cached in
 * `cacheDir/car-artwork`.
 */
class ArtworkProvider : ContentProvider() {
  companion object {
    private const val DIR = "car-artwork"
    private const val MAX_FILES = 300
    private val urls = ConcurrentHashMap<String, String>()

    fun authority(context: Context) = "${context.packageName}.mediamax.artwork"

    /** Maps an http(s) artwork URL to a content URI this provider serves, or null. */
    fun contentUri(context: Context, url: String?): Uri? {
      if (url.isNullOrEmpty() || !(url.startsWith("http://") || url.startsWith("https://"))) return null
      val key = sha1(url)
      urls[key] = url
      return Uri.Builder()
        .scheme(ContentResolver.SCHEME_CONTENT)
        .authority(authority(context))
        .appendPath(key)
        .build()
    }

    private fun sha1(value: String): String =
      MessageDigest.getInstance("SHA-1").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
  }

  override fun onCreate(): Boolean = true

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? {
    val ctx = context ?: throw FileNotFoundException(uri.toString())
    val key = uri.lastPathSegment
    if (key == null || !key.matches(Regex("[0-9a-f]{40}"))) throw FileNotFoundException(uri.toString())
    val dir = File(ctx.cacheDir, DIR).apply { mkdirs() }
    val file = File(dir, key)
    if (!file.exists() || file.length() == 0L) {
      val url = urls[key] ?: throw FileNotFoundException(uri.toString())
      download(url, file)
      prune(dir)
    }
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
  }

  private fun download(url: String, target: File) {
    val tmp = File(target.parentFile, "${target.name}.tmp")
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 10_000
      connection.readTimeout = 15_000
      connection.instanceFollowRedirects = true
      if (connection.responseCode !in 200..299) throw FileNotFoundException("HTTP ${connection.responseCode} for artwork")
      connection.inputStream.use { input -> tmp.outputStream().use { output -> input.copyTo(output) } }
      if (!tmp.renameTo(target)) throw FileNotFoundException("Could not cache artwork")
    } catch (e: FileNotFoundException) {
      tmp.delete()
      throw e
    } catch (e: Exception) {
      tmp.delete()
      throw FileNotFoundException(e.message ?: "Artwork download failed")
    } finally {
      connection.disconnect()
    }
  }

  private fun prune(dir: File) {
    val files = dir.listFiles() ?: return
    if (files.size <= MAX_FILES) return
    files.sortedBy { it.lastModified() }.take(files.size - MAX_FILES).forEach { it.delete() }
  }

  override fun getType(uri: Uri): String = "image/*"

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
