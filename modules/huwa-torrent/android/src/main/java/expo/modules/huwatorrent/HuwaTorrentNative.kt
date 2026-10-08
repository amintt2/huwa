package expo.modules.huwatorrent

import android.content.Context
import android.util.Log

/**
 * JNI surface of libhuwa_torrent_core.so (native/huwa-torrent-core/src/jni_android.rs).
 * Symbols: Java_expo_modules_huwatorrent_HuwaTorrentNative_native{Version,InitTls,Init,Call,Shutdown}.
 * `isLinked` is false when the .so is absent from the APK (build without HUWA_TORRENT=1).
 */
object HuwaTorrentNative {
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

  @Volatile
  private var tlsReady: Boolean = false

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
   * Once per process, before [initialize]. If it fails the engine still starts: UDP trackers and
   * DHT work, only HTTPS requests (https trackers, torrents added by https URL) fail.
   */
  @Synchronized
  fun initTls(context: Context) {
    if (tlsReady) return
    try {
      nativeInitTls(context.applicationContext)
      tlsReady = true
    } catch (e: Throwable) {
      Log.w("HuwaTorrent", "TLS verifier init failed, HTTPS trackers unavailable", e)
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
