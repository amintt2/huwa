package expo.modules.huwatorrent

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal class TorrentUnavailableException : CodedException(
  code = "ERR_TORRENT_UNAVAILABLE",
  message = "The torrent engine is not linked in this build (build with HUWA_TORRENT=1 after scripts/build-torrent.sh android)",
  cause = null
)

private const val TORRENT_STATUS_EVENT = "onTorrentStatus"

class HuwaTorrentModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var pollJob: Job? = null

  override fun definition() = ModuleDefinition {
    Name("HuwaTorrent")

    Events(TORRENT_STATUS_EVENT)

    Constant("nativeVersion") {
      if (HuwaTorrentNative.isLinked) HuwaTorrentNative.nativeVersion() else "unlinked"
    }

    Function("isAvailable") {
      HuwaTorrentNative.isLinked
    }

    Function("isOnCellular") {
      isOnCellular()
    }

    Function("defaultDataDir") {
      File(appContext.persistentFilesDirectory, "huwa-torrent").apply { mkdirs() }.absolutePath
    }

    // AsyncFunction bodies run off the main thread (module queue), the JNI calls block.
    AsyncFunction("initialize") { configJson: String ->
      ensureLinked()
      HuwaTorrentNative.initialize(configJson)
    }

    AsyncFunction("call") { method: String, argsJson: String ->
      ensureLinked()
      HuwaTorrentNative.nativeCall(method, argsJson)
    }

    AsyncFunction<Unit>("shutdown") {
      HuwaTorrentNative.shutdown()
    }

    OnStartObserving {
      startPolling()
    }

    OnStopObserving {
      stopPolling()
    }

    OnDestroy {
      stopPolling()
      scope.cancel()
      HuwaTorrentNative.shutdown()
    }
  }

  private fun ensureLinked() {
    if (!HuwaTorrentNative.isLinked) throw TorrentUnavailableException()
  }

  private fun isOnCellular(): Boolean {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return false
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    val cellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
    val unmetered = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    return cellular && !unmetered
  }

  /** Pushes the torrent list to JS once per second while someone listens. */
  private fun startPolling() {
    if (pollJob != null || !HuwaTorrentNative.isLinked) return
    pollJob = scope.launch {
      while (isActive) {
        delay(1000)
        if (!HuwaTorrentNative.isInitialized) continue
        val json = try {
          HuwaTorrentNative.nativeCall("list", "{}")
        } catch (e: Throwable) {
          continue
        }
        sendEvent(TORRENT_STATUS_EVENT, mapOf("json" to json))
      }
    }
  }

  private fun stopPolling() {
    pollJob?.cancel()
    pollJob = null
  }
}
