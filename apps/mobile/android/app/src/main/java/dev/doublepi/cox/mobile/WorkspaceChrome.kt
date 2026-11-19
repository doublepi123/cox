package dev.doublepi.cox.mobile

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

internal fun parseHexColor(value: String): Int? {
    val trimmed = value.trim()
    if (Regex("^#[0-9a-fA-F]{6}$").matches(trimmed)) {
        return Color.parseColor(trimmed)
    }
    if (Regex("^#[0-9a-fA-F]{3}$").matches(trimmed)) {
        val r = trimmed[1]
        val g = trimmed[2]
        val b = trimmed[3]
        return Color.parseColor("#$r$r$g$g$b$b")
    }
    return null
}

internal fun isLightSurfaceColor(color: Int): Boolean {
    val r = Color.red(color)
    val g = Color.green(color)
    val b = Color.blue(color)
    val luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return luminance >= 145.0
}

internal const val WORKSPACE_VIEWPORT_LOCK_SCRIPT = """
(function(){
  var content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content";
  var apply = function() {
    var head = document.head || document.documentElement;
    if (!head) return;
    var meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "viewport");
      head.insertBefore(meta, head.firstChild);
    }
    if (meta.getAttribute("content") !== content) meta.setAttribute("content", content);
  };
  apply();
  document.addEventListener("DOMContentLoaded", apply);
})();
"""

internal fun lockWorkspaceViewport(settings: android.webkit.WebSettings) {
    settings.useWideViewPort = true
    settings.loadWithOverviewMode = false
    settings.textZoom = 100
    settings.setSupportZoom(false)
    settings.builtInZoomControls = false
    settings.displayZoomControls = false
}

internal enum class WorkspaceSystemBack { History, ConnectionManager }

internal fun workspaceSystemBack(canGoBack: Boolean): WorkspaceSystemBack =
    if (canGoBack) WorkspaceSystemBack.History else WorkspaceSystemBack.ConnectionManager

internal object WorkspaceChrome {
    fun defaultBackgroundColor(context: Context): Int {
        val night =
            (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        return if (night) Color.parseColor("#070908") else Color.parseColor("#F5F7F3")
    }

    fun applySystemBars(activity: Activity, backgroundColor: Int) {
        val window = activity.window
        window.decorView.setBackgroundColor(backgroundColor)
        @Suppress("DEPRECATION")
        run {
            window.statusBarColor = backgroundColor
            window.navigationBarColor = backgroundColor
        }
        val lightBars = isLightSurfaceColor(backgroundColor)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = lightBars
            isAppearanceLightNavigationBars = lightBars
        }
    }

    fun installWindowInsets(activity: Activity) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val decor = window.decorView
        ViewCompat.setOnApplyWindowInsetsListener(decor) { view, insets ->
            val contentInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(contentInsets.left, contentInsets.top, contentInsets.right, contentInsets.bottom)
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(decor)
    }

    fun styleCapsuleControl(control: TextView, lightSurface: Boolean) {
        val density = control.resources.displayMetrics.density
        control.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 999f * density
            setColor(
                if (lightSurface) Color.parseColor("#EBFFFFFF")
                else Color.parseColor("#E018181B"),
            )
            setStroke(
                (1f * density).toInt().coerceAtLeast(1),
                if (lightSurface) Color.parseColor("#29121712")
                else Color.parseColor("#38FFFFFF"),
            )
        }
        control.setTextColor(
            if (lightSurface) Color.parseColor("#121712")
            else Color.parseColor("#F4F4F5"),
        )
    }
}
