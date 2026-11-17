package dev.doublepi.cox.mobile

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
    }
}
