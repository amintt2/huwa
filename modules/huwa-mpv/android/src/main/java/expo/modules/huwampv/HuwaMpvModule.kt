package expo.modules.huwampv

import android.content.Context
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

/** Placeholder view: libmpv is not linked on Android yet (see modules/huwa-mpv/README.md). */
class HuwaMpvView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  init {
    setBackgroundColor(android.graphics.Color.BLACK)
  }
}

class HuwaMpvModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HuwaMpv")

    Function("isAvailable") { false }

    Function("hardwareDecoders") { emptyMap<String, Boolean>() }

    Constant("mpvVersion") { "unlinked" }

    View(HuwaMpvView::class) {
      Events("onReady", "onLoaded", "onProgress", "onStateChange", "onTracks", "onEnd", "onMpvError")
    }
  }
}
