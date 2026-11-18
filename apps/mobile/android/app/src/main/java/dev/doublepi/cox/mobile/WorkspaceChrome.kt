package dev.doublepi.cox.mobile

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.TextView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale

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

internal enum class WorkspaceSystemBack { History, ConnectionManager }

internal fun workspaceSystemBack(canGoBack: Boolean): WorkspaceSystemBack =
    if (canGoBack) WorkspaceSystemBack.History else WorkspaceSystemBack.ConnectionManager

internal fun safeAreaCssPixels(pixels: Int, density: Float): String {
    if (pixels <= 0 || density <= 0f || !density.isFinite()) return "0px"
    return String.format(Locale.US, "%.2fpx", pixels / density)
}

internal object WorkspaceChrome {
    private var launcherSafeAreaScript: String? = null
    fun defaultBackgroundColor(context: Context): Int {
        val night =
            (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        return if (night) Color.parseColor("#070908") else Color.parseColor("#F5F7F3")
    }

    fun applySystemBars(activity: Activity, backgroundColor: Int) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)
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

    fun installLauncherWebViewInsets(target: View) {
        ViewCompat.setOnApplyWindowInsetsListener(target) { view, insets ->
            publishLauncherSafeArea(view, insets)
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
        }
        ViewCompat.requestApplyInsets(target)
    }

    private fun publishLauncherSafeArea(view: View, insets: WindowInsetsCompat) {
        val webView = view as? android.webkit.WebView ?: return
        val bars = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val density = view.resources.displayMetrics.density
        val top = safeAreaCssPixels(bars.top, density)
        val right = safeAreaCssPixels(bars.right, density)
        val bottom = safeAreaCssPixels(bars.bottom, density)
        val left = safeAreaCssPixels(bars.left, density)
        val script =
            """
            (function(){
              var root = document.documentElement;
              if (!root) return;
              root.style.setProperty('--cox-safe-top','$top');
              root.style.setProperty('--cox-safe-right','$right');
              root.style.setProperty('--cox-safe-bottom','$bottom');
              root.style.setProperty('--cox-safe-left','$left');
            })();
            """.trimIndent()
        launcherSafeAreaScript = script
        webView.evaluateJavascript(script, null)
    }

    fun republishLauncherSafeArea(webView: android.webkit.WebView) {
        launcherSafeAreaScript?.let { webView.evaluateJavascript(it, null) }
    }

    fun installChildWebViewInsetsShield(
        target: View,
        onImeVisibilityChanged: ((Boolean) -> Unit)? = null,
    ) {
        var lastImeVisible: Boolean? = null
        val reportIme = { visible: Boolean ->
            if (lastImeVisible != visible) {
                lastImeVisible = visible
                onImeVisibilityChanged?.invoke(visible)
            }
        }
        ViewCompat.setOnApplyWindowInsetsListener(target) { view, insets ->
            val sysInsets = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(sysInsets.left, sysInsets.top, sysInsets.right, sysInsets.bottom)
            val imeInsets = insets.getInsets(WindowInsetsCompat.Type.ime())
            val decorHeight = view.rootView?.height ?: 0
            val heightDelta = (decorHeight - view.height).coerceAtLeast(0)
            val thresholdPx = (120f * view.resources.displayMetrics.density).toInt()
            val imeVisible =
                insets.isVisible(WindowInsetsCompat.Type.ime()) ||
                    imeInsets.bottom > 0 ||
                    (decorHeight > 0 && heightDelta > thresholdPx)
            reportIme(imeVisible)
            WindowInsetsCompat.Builder(insets)
                .setInsets(
                    WindowInsetsCompat.Type.systemBars() or
                        WindowInsetsCompat.Type.displayCutout() or
                        WindowInsetsCompat.Type.ime(),
                    Insets.NONE,
                )
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
        }
        if (onImeVisibilityChanged != null) {
            target.viewTreeObserver.addOnGlobalLayoutListener {
                val rootHeight = target.rootView?.height ?: return@addOnGlobalLayoutListener
                if (rootHeight <= 0 || target.height <= 0) return@addOnGlobalLayoutListener
                val thresholdPx = (120f * target.resources.displayMetrics.density).toInt()
                reportIme((rootHeight - target.height) > thresholdPx)
            }
        }
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
