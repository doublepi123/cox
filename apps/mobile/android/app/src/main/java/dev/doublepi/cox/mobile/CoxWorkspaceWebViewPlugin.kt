package dev.doublepi.cox.mobile

import android.content.Intent
import android.net.Uri
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
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
    private var activeName: String? = null
    private val downloads by lazy { WorkspaceDownloads(context.applicationContext) }
    private val host = object : WorkspaceHost {
        override val activity get() = this@CoxWorkspaceWebViewPlugin.activity
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
        val root = container()
        (workspace.webView.parent as? ViewGroup)?.removeView(workspace.webView)
        root.addView(workspace.webView, FrameLayout.LayoutParams(-1, -1))
        root.addView(Button(activity).apply {
            text = "Servers"
            contentDescription = "Return to server switcher; hold to manage connections"
            setOnClickListener { host.launchEvent("openServerSwitcher") }
            setOnLongClickListener { host.launchEvent("openConnectionManager"); true }
        }, FrameLayout.LayoutParams(-2, -2, Gravity.TOP or Gravity.END).apply {
            topMargin = (12 * context.resources.displayMetrics.density).toInt()
            marginEnd = topMargin
        })
        activeName = workspace.identity.profileName
    }

    private fun showIsolationPanel(identity: WorkspaceIdentity) {
        dismiss()
        val root = container()
        val panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(32, 32, 32, 32)
        }
        panel.addView(TextView(activity).apply {
            text = "Isolated multi-server workspaces require an updated Android System WebView. Update it in the Play Store, or open this server in your browser."
            textSize = 18f
        })
        panel.addView(Button(activity).apply {
            text = "Open in Browser"
            setOnClickListener { host.openExternal(identity.origin) }
        })
        panel.addView(Button(activity).apply {
            text = "Back to Launcher"
            setOnClickListener { dismiss() }
        })
        root.addView(panel, FrameLayout.LayoutParams(-1, -1))
    }

    private fun container(): FrameLayout {
        val root = FrameLayout(activity).apply {
            setBackgroundColor(android.graphics.Color.WHITE)
            fitsSystemWindows = true
            isClickable = true
        }
        activity.addContentView(root, ViewGroup.LayoutParams(-1, -1))
        overlay = root
        return root
    }

    private fun dismiss() {
        overlay?.let { root ->
            root.removeAllViews()
            (root.parent as? ViewGroup)?.removeView(root)
        }
        overlay = null
        activeName = null
    }

    override fun handleOnDestroy() {
        dismiss()
        pool.values.forEach { it.destroy() }
        pool.clear()
        downloads.close()
        super.handleOnDestroy()
    }
}
