package tv.mediamax.car

import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Process-wide meeting point of the JS module ([MediaMaxCarModule], which lives as long as the React
 * Native runtime) and the Android Auto service ([MediaMaxCarService], which lives while Android Auto
 * is bound to it). Either can exist without the other.
 */
internal object CarBridge {
  const val NOT_READY_MESSAGE = "Open Vibe on your phone to start listening"
  const val TIMEOUT_MESSAGE = "Couldn't reach your media server"
  private const val TIMEOUT_MS = 20_000L

  private val mainHandler = Handler(Looper.getMainLooper())
  private val pending = ConcurrentHashMap<String, (List<CarNodeRecord>?, String?) -> Unit>()
  private val sequence = AtomicInteger()

  @Volatile private var module: MediaMaxCarModule? = null

  /** The JS car bridge is mounted and answers browse requests. */
  @Volatile var jsReady: Boolean = false
    private set

  @Volatile var nowPlaying: NowPlayingRecord? = null
    private set

  /** An Android Auto (or other external) media browser is connected. */
  @Volatile var connected: Boolean = false

  /** Main thread only. */
  var service: MediaMaxCarService? = null

  fun attach(module: MediaMaxCarModule) {
    this.module = module
  }

  fun detach(module: MediaMaxCarModule) {
    if (this.module === module) {
      this.module = null
      setReady(false)
    }
  }

  fun emit(event: String, body: Map<String, Any?>) {
    module?.sendEvent(event, body)
  }

  /**
   * Asks JS for a list of nodes (main thread). [callback] runs on the main thread with the nodes, or
   * with null and an error message.
   */
  fun request(event: String, payload: Map<String, Any?>, callback: (List<CarNodeRecord>?, String?) -> Unit) {
    val target = module
    if (target == null || !jsReady) {
      callback(null, NOT_READY_MESSAGE)
      return
    }
    val requestId = "aa" + sequence.incrementAndGet()
    pending[requestId] = callback
    target.sendEvent(event, payload + ("requestId" to requestId))
    mainHandler.postDelayed({ pending.remove(requestId)?.invoke(null, TIMEOUT_MESSAGE) }, TIMEOUT_MS)
  }

  fun resolve(requestId: String, nodes: List<CarNodeRecord>?, error: String?) {
    mainHandler.post { pending.remove(requestId)?.invoke(nodes, error) }
  }

  fun setReady(ready: Boolean) {
    jsReady = ready
    mainHandler.post { service?.onJsReadyChanged() }
  }

  fun updateNowPlaying(state: NowPlayingRecord?) {
    nowPlaying = state
    mainHandler.post { service?.onNowPlayingChanged() }
  }

  fun invalidate(parentId: String?) {
    mainHandler.post { service?.invalidate(parentId) }
  }
}
