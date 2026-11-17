package dev.doublepi.cox.mobile

import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale
import kotlin.math.abs

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

internal fun shouldShowFallbackServersPill(
    imeVisible: Boolean,
    webSwitcherMounted: Boolean,
): Boolean = !imeVisible && !webSwitcherMounted

internal fun clampPillCoordinate(value: Float, minBound: Float, maxBound: Float): Float =
    value.coerceIn(minBound, maxBound.coerceAtLeast(minBound))

internal object WorkspaceChrome {
    fun defaultBackgroundColor(context: Context): Int {
        val night =
            (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
                Configuration.UI_MODE_NIGHT_YES
        return if (night) Color.parseColor("#111215") else Color.parseColor("#F5F7F3")
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

    fun installLauncherWebViewImeShield(target: View) {
        ViewCompat.setOnApplyWindowInsetsListener(target) { _, insets ->
            WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build()
        }
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

    fun styleServersPill(pill: TextView, lightSurface: Boolean) {
        val density = pill.resources.displayMetrics.density
        pill.background = GradientDrawable().apply {
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
        pill.setTextColor(
            if (lightSurface) Color.parseColor("#121712")
            else Color.parseColor("#F4F4F5"),
        )
    }

    fun createDraggableServersPill(
        activity: Activity,
        lightSurface: Boolean,
        onTap: () -> Unit,
        onLongPress: () -> Unit,
    ): TextView {
        val density = activity.resources.displayMetrics.density
        val padH = (13f * density).toInt()
        val heightPx = (34f * density).toInt()
        val marginPx = (12f * density).toInt()
        val touchSlop = ViewConfiguration.get(activity).scaledTouchSlop
        val isZh = Locale.getDefault().language.lowercase(Locale.ROOT).startsWith("zh")
        val pill = TextView(activity).apply {
            text = if (isZh) "服务器" else "Servers"
            contentDescription = "Return to server switcher; hold to manage connections"
            isAllCaps = false
            gravity = Gravity.CENTER
            minHeight = heightPx
            setPadding(padH, 0, padH, 0)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f)
            elevation = 4f * density
            isClickable = true
            isLongClickable = true
            styleServersPill(this, lightSurface)
            setOnClickListener { onTap() }
            setOnLongClickListener {
                onLongPress()
                true
            }
        }
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0f
        var startY = 0f
        var dragging = false
        pill.setOnTouchListener { view, event ->
            val parent = view.parent as? View ?: return@setOnTouchListener false
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = view.x
                    startY = view.y
                    dragging = false
                    false
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (!dragging && (abs(dx) > touchSlop || abs(dy) > touchSlop)) {
                        dragging = true
                        view.cancelLongPress()
                    }
                    if (dragging) {
                        val maxX = (parent.width - view.width - marginPx).toFloat()
                        val maxY = (parent.height - view.height - marginPx).toFloat()
                        view.x = clampPillCoordinate(startX + dx, marginPx.toFloat(), maxX)
                        view.y = clampPillCoordinate(startY + dy, marginPx.toFloat(), maxY)
                        true
                    } else {
                        false
                    }
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        val maxX = (parent.width - view.width - marginPx).toFloat()
                        val midX = parent.width / 2f
                        val targetX = if (view.x + view.width / 2f < midX) marginPx.toFloat() else maxX.coerceAtLeast(marginPx.toFloat())
                        view.animate().x(targetX).setDuration(140).start()
                        dragging = false
                        true
                    } else {
                        false
                    }
                }
                else -> false
            }
        }
        pill.layoutParams = FrameLayout.LayoutParams(-2, heightPx, Gravity.TOP or Gravity.END).apply {
            topMargin = (10f * density).toInt()
            marginEnd = marginPx
        }
        return pill
    }
}
