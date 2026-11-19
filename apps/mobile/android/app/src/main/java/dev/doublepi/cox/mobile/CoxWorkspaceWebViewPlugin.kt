package dev.doublepi.cox.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "CoxWorkspaceWebView")
class CoxWorkspaceWebViewPlugin : Plugin() {
    private val pool = linkedMapOf<String, WorkspaceView>()
    private val policy = WorkspacePoolPolicy()
    private var overlay: FrameLayout? = null
    private var activeWorkspace: WorkspaceView? = null
    private var workspaceBack: OnBackPressedCallback? = null
    private var activeName: String? = null
    private var launcherColor: Int? = null
    internal val hasActiveOverlay: Boolean
        get() = overlay != null || preflight.hasActiveSignIn
    private val downloads by lazy { WorkspaceDownloads(context.applicationContext) }
    private val preflight by lazy {
        WorkspacePreflight(
            plugin = this,
            evictPooledView = { profileName -> pool.remove(profileName)?.destroy() },
            restoreLauncherBars = { restoreLauncherChrome() },
        )
    }
    private val host = object : WorkspaceHost {
        override val activity get() = this@CoxWorkspaceWebViewPlugin.activity as MainActivity
        override val downloads get() = this@CoxWorkspaceWebViewPlugin.downloads
        override fun launchEvent(event: String) {
            dismiss()
            notifyListeners(event, JSObject())
        }
        override fun remember(identity: WorkspaceIdentity, path: String) {
            policy.remember(identity.profileName, path)
            notifyListeners("workspaceLocation", JSObject().put("profileId", identity.profileId).put("path", path))
        }
        override fun rendererGone(profileName: String) {
            pool.remove(profileName)
            launchEvent("openServerSwitcher")
        }
        override fun openExternal(url: String) {
            try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            catch (_: android.content.ActivityNotFoundException) {
                android.widget.Toast.makeText(activity, "Install a browser to open this server", android.widget.Toast.LENGTH_LONG).show()
            }
        }
        override fun onWorkspaceChromeChanged(profileName: String, backgroundColor: Int) {
            if (activeName != profileName) return
            overlay?.setBackgroundColor(backgroundColor)
            WorkspaceChrome.applySystemBars(activity, backgroundColor)
        }
        override fun onWebSwitcherChanged(profileName: String, mounted: Boolean) {
            if (activeName != profileName || !mounted) return
        }
        override fun onContentReady(profileName: String) {
            if (activeName != profileName) return
            revealOverlay()
        }
    }

    private fun motionScale(): Float =
        Settings.Global.getFloat(activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

    private fun revealOverlay() {
        val root = overlay ?: return
        if (root.alpha >= 1f) return
        if (motionScale() == 0f) {
            root.alpha = 1f
            return
        }
        root.animate().alpha(1f).setDuration(180).start()
    }

    internal fun restoreLauncherChrome() {
        val bg = launcherColor ?: WorkspaceChrome.defaultBackgroundColor(activity)
        WorkspaceChrome.applySystemBars(activity, bg)
        bridge?.webView?.setBackgroundColor(bg)
    }

    @PluginMethod
    fun syncLauncherTheme(call: PluginCall) {
        activity.runOnUiThread {
            val hex = call.getString("color")
            val parsed = hex?.let(::parseHexColor)
            launcherColor = parsed
            if (!hasActiveOverlay) {
                restoreLauncherChrome()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun requestProfileUrl(call: PluginCall) {
        preflight.requestProfileUrl(call)
    }

    @PluginMethod
    fun signInToGateway(call: PluginCall) {
        preflight.signInToGateway(call)
    }

    @PluginMethod
    fun openWorkspace(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val identity = WorkspaceIdentity.parse(
                    requireNotNull(call.getString("profileId")),
                    requireNotNull(call.getString("origin")),
                    call.getBoolean("allowInsecureHttp", false) == true,
                )
                val supported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                when (val decision = policy.open(identity.profileName, supported)) {
                    OpenDecision.IsolationPanel -> {
                        showIsolationPanel(identity)
                        call.resolve()
                    }
                    is OpenDecision.Workspace -> {
                        decision.evicted?.let { pool.remove(it)?.destroy() }
                        val options = WorkspaceOptions(
                            identity,
                            call.getString("label") ?: "Cox",
                            (call.getInt("serverCount") ?: 1).coerceAtLeast(0),
                            call.getBoolean("gatewayLogin", false) == true,
                        )
                        val existing = pool[identity.profileName]
                        if (existing != null && existing.options != options) {
                            existing.destroy()
                            pool.remove(identity.profileName)
                        }
                        val workspace = pool[identity.profileName] ?: WorkspaceView(host, options).also {
                            pool[identity.profileName] = it
                            val path = call.getString("lastThreadPath") ?: decision.path
                            it.load(path)
                        }
                        show(workspace)
                        call.resolve()
                    }
                }
            } catch (error: Exception) {
                android.util.Log.w("CoxMobile", "Workspace open failed", error)
                call.reject("The isolated workspace could not be opened", error)
            }
        }
    }

    @PluginMethod
    fun closeWorkspace(call: PluginCall) {
        activity.runOnUiThread { dismiss(); call.resolve() }
    }

    @PluginMethod
    fun forgetProfile(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val identity = WorkspaceIdentity.parse(
                    requireNotNull(call.getString("profileId")),
                    requireNotNull(call.getString("origin")),
                    true,
                )
                check(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                val name = identity.profileName
                policy.forget(name)
                if (activeName == name) dismiss()
                pool.remove(name)?.destroy()
                downloads.retire(name) {
                    try {
                        val store = ProfileStore.getInstance()
                        if (name in store.allProfileNames) check(store.deleteProfile(name))
                        call.resolve()
                    } catch (error: Exception) {
                        android.util.Log.w("CoxMobile", "Workspace profile deletion failed", error)
                        call.reject("The isolated profile could not be deleted", error)
                    }
                }
            } catch (error: Exception) {
                call.reject("The isolated profile could not be deleted", error)
            }
        }
    }

    private fun show(workspace: WorkspaceView) {
        dismiss()
        activeWorkspace = workspace
        activeName = workspace.identity.profileName
        val bg = launcherColor ?: WorkspaceChrome.defaultBackgroundColor(activity)
        workspace.prepareBackdrop(bg)
        val painted = workspace.webView.progress == 100 && !workspace.webView.url.isNullOrEmpty()
        val root = container(bg, hiddenUntilPaint = !painted)
        (workspace.webView.parent as? ViewGroup)?.removeView(workspace.webView)
        root.addView(workspace.webView, FrameLayout.LayoutParams(-1, -1))
        WorkspaceChrome.applySystemBars(activity, bg)
        workspace.refreshChromeProbe()
    }

    private fun showIsolationPanel(identity: WorkspaceIdentity) {
        dismiss()
        val bg = WorkspaceChrome.defaultBackgroundColor(activity)
        val root = container(bg)
        val panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
        }
        panel.addView(TextView(activity).apply {
            text = "Isolated multi-server workspaces require an updated Android System WebView. Update it in the Play Store, or open this server in your browser."
            textSize = 18f
            setTextColor(if (isLightSurfaceColor(bg)) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        })
        panel.addView(Button(activity).apply {
            text = "Open in Browser"
            isAllCaps = false
            setOnClickListener { host.openExternal(identity.origin) }
        })
        panel.addView(Button(activity).apply {
            text = "Back to Launcher"
            isAllCaps = false
            setOnClickListener { dismiss() }
        })
        root.addView(panel, FrameLayout.LayoutParams(-1, -1))
        WorkspaceChrome.applySystemBars(activity, bg)
    }

    private fun container(
        backgroundColor: Int,
        hiddenUntilPaint: Boolean = false,
    ): FrameLayout {
        val root = FrameLayout(activity).apply {
            setBackgroundColor(backgroundColor)
            fitsSystemWindows = false
            isClickable = true
            if (hiddenUntilPaint && motionScale() != 0f) alpha = 0f
        }
        activity.getSharedPreferences("cox.workspace.serversPill", Context.MODE_PRIVATE)
            .edit()
            .clear()
            .apply()
        val callback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val web = activeWorkspace?.webView
                if (web != null && workspaceSystemBack(web.canGoBack()) == WorkspaceSystemBack.History) {
                    web.goBack()
                } else {
                    host.launchEvent("openConnectionManager")
                }
            }
        }
        activity.onBackPressedDispatcher.addCallback(activity, callback)
        workspaceBack = callback
        activity.addContentView(root, ViewGroup.LayoutParams(-1, -1))
        overlay = root
        return root
    }

    private fun dismiss() {
        workspaceBack?.remove()
        workspaceBack = null
        activeWorkspace?.let { host.activity.cancelFileChooser(it.webView) }
        activeWorkspace = null
        val hadOverlay = overlay != null
        overlay?.let { root ->
            root.removeAllViews()
            (root.parent as? ViewGroup)?.removeView(root)
        }
        overlay = null
        activeName = null
        if (hadOverlay && !preflight.hasActiveSignIn) {
            restoreLauncherChrome()
        }
    }

    override fun handleOnDestroy() {
        preflight.closeSignIn()
        dismiss()
        pool.values.forEach { it.destroy() }
        pool.clear()
        downloads.close()
        super.handleOnDestroy()
    }
}
