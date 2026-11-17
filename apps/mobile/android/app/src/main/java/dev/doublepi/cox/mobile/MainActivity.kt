package dev.doublepi.cox.mobile

import android.content.res.Configuration
import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.getcapacitor.Plugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CoxWorkspaceWebViewPlugin::class.java)
        try {
            registerPlugin(Class.forName("dev.doublepi.cox.mobile.CoxVaultPlugin").asSubclass(Plugin::class.java))
        } catch (_: ClassNotFoundException) {
            android.util.Log.i("CoxMobile", "Credential vault plugin is not installed")
        }
        super.onCreate(savedInstanceState)
        WorkspaceChrome.applySystemBars(this, WorkspaceChrome.defaultBackgroundColor(this))
        bridge?.webView?.let { webView ->
            webView.setBackgroundColor(WorkspaceChrome.defaultBackgroundColor(this))
            WorkspaceChrome.installLauncherWebViewImeShield(webView)
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val plugin = bridge?.getPlugin("CoxWorkspaceWebView")?.instance as? CoxWorkspaceWebViewPlugin
        if (plugin?.hasActiveOverlay != true) {
            val bg = WorkspaceChrome.defaultBackgroundColor(this)
            WorkspaceChrome.applySystemBars(this, bg)
            bridge?.webView?.setBackgroundColor(bg)
        }
    }
}
