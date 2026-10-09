package expo.modules.huwatorrent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.security.NetworkSecurityPolicy
import android.util.Log
import org.json.JSONObject

/**
 * CI self-test of the torrent engine's HTTPS stack (scripts/android-smoke.sh): initialises the TLS
 * verifier exactly like the module does, then has the Rust engine GET each URL (`tlsCheck`, see
 * native/huwa-torrent-core/src/tls_check.rs) and logs the JSON results, plus the app's cleartext
 * policy for the loopback servers.
 *
 * Inert in a normal install: declared `android:enabled="false"` and `android:exported="false"` in
 * the module manifest, so nothing outside the app can reach it unless root or the system first
 * enables it (`adb root` + `pm enable` on the CI emulator). The app never sends it.
 *
 *   am broadcast -n com.amintt2.huwa/expo.modules.huwatorrent.HuwaTorrentTlsCheckReceiver \
 *     --esa urls https://a.example/,https://b.example/
 */
class HuwaTorrentTlsCheckReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val urls = intent.getStringArrayExtra("urls")?.toList().orEmpty().ifEmpty { listOf(DEFAULT_URL) }
    val app = context.applicationContext
    val pending = goAsync()
    Thread({
      try {
        val policy = NetworkSecurityPolicy.getInstance()
        Log.i(
          TAG,
          "tlsCheck cleartext 127.0.0.1=${policy.isCleartextTrafficPermitted("127.0.0.1")} " +
            "localhost=${policy.isCleartextTrafficPermitted("localhost")} " +
            "example.com=${policy.isCleartextTrafficPermitted("example.com")}"
        )
        if (HuwaTorrentNative.isLinked) {
          HuwaTorrentNative.ensureTls(app)
          for (url in urls.take(5)) {
            val out = HuwaTorrentNative.nativeCall("tlsCheck", JSONObject().put("url", url).toString())
            Log.i(TAG, "tlsCheck $url -> $out")
          }
          Log.i(TAG, "tlsCheck done")
        } else {
          Log.w(TAG, "tlsCheck engine not linked")
        }
      } catch (e: Throwable) {
        Log.e(TAG, "tlsCheck failed", e)
      } finally {
        pending.finish()
      }
    }, "huwa-tls-check").start()
  }

  private companion object {
    const val TAG = "HuwaTorrent"
    const val DEFAULT_URL = "https://www.google.com/generate_204"
  }
}
