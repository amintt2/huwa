package expo.modules.huwatorrent

import android.content.Context
import android.util.Log

/**
 * JNI surface of libhuwa_torrent_core.so (native/huwa-torrent-core/src/jni_android.rs).
 * Symbols: Java_expo_modules_huwatorrent_HuwaTorrentNative_native{Version,InitTls,Init,Call,Shutdown}.
 * `isLinked` is false when the .so is absent from the APK (build without HUWA_TORRENT=1).
 */
object HuwaTorrentNative {
  private const val TAG = "HuwaTorrent"

  val isLinked: Boolean = try {
    System.loadLibrary("huwa_torrent_core")
    true
  } catch (e: UnsatisfiedLinkError) {
    false
  } catch (e: SecurityException) {
    false
  }

  @Volatile
  var isInitialized: Boolean = false
    private set

  @JvmStatic
  external fun nativeVersion(): String

  /** Set once [ensureTls] has run (successfully or not); its lock is not the engine's. */
  @Volatile
  private var tlsDone: Boolean = false
  private val tlsLock = Any()

  /** Gives the Rust HTTPS stack (rustls-platform-verifier) the app Context. Throws on failure. */
  @JvmStatic
  external fun nativeInitTls(context: Context)

  @JvmStatic
  external fun nativeInit(configJson: String): String

  @JvmStatic
  external fun nativeCall(method: String, argsJson: String): String

  @JvmStatic
  external fun nativeShutdown()

  /**
   * Gives the app Context to the Rust HTTPS stack (rustls-platform-verifier), once per process and
   * before anything that can reach the network: called by every entry point of [HuwaTorrentModule]
   * (initialize, call: the HTTP proxy runs without [initialize]) and by the CI self-test receiver.
   * A failure is logged and not retried (it would fail the same way): the engine still starts, UDP
   * trackers and DHT work, HTTPS requests (https trackers, proxied https links) fail.
   */
  fun ensureTls(context: Context) {
    if (tlsDone || !isLinked) return
    // Concurrent callers wait here until the first one is done: none goes on to the network early.
    synchronized(tlsLock) {
      if (tlsDone) return
      try {
        nativeInitTls(context.applicationContext)
        Log.i(TAG, "TLS verifier initialised")
      } catch (e: Throwable) {
        Log.w(TAG, "TLS verifier init failed, HTTPS requests of the engine unavailable", e)
      } finally {
        tlsDone = true
      }
    }
  }

  @Synchronized
  fun initialize(configJson: String): String {
    val out = nativeInit(configJson)
    if (out.contains("\"ok\"")) isInitialized = true
    return out
  }

  @Synchronized
  fun shutdown() {
    if (!isLinked) return
    nativeShutdown()
    isInitialized = false
  }
}
