package expo.modules.huwatorrent

/**
 * JNI surface of libhuwa_torrent_core.so (native/huwa-torrent-core/src/jni_android.rs).
 * Symbols: Java_expo_modules_huwatorrent_HuwaTorrentNative_native{Version,Init,Call,Shutdown}.
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

  @JvmStatic
  external fun nativeInit(configJson: String): String

  @JvmStatic
  external fun nativeCall(method: String, argsJson: String): String

  @JvmStatic
  external fun nativeShutdown()

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
