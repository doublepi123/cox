package dev.doublepi.cox.mobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.result.contract.ActivityResultContracts
import com.getcapacitor.BridgeActivity
import com.getcapacitor.Plugin

class MainActivity : BridgeActivity() {
    private var fileChooser: Pair<WebView, ValueCallback<Array<Uri>>>? = null
    private var choosingFiles = false
    private val selectFiles = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val callback = fileChooser?.second
        fileChooser = null
        choosingFiles = false
        val data = result.data
        val files = if (result.resultCode != Activity.RESULT_OK || data == null) null else {
            val uris = data.clipData?.let { clip ->
                List(clip.itemCount) { clip.getItemAt(it).uri }
            } ?: listOfNotNull(data.data)
            uris.filter { it.scheme == "content" && it.authority != "$packageName.fileprovider" }
                .takeIf { it.isNotEmpty() }
                ?.toTypedArray()
        }
        callback?.onReceiveValue(files)
    }

    internal fun showFileChooser(
        webView: WebView,
        callback: ValueCallback<Array<Uri>>,
        params: WebChromeClient.FileChooserParams,
    ) {
        if (choosingFiles) {
            callback.onReceiveValue(null)
            return
        }
        val request = params.createIntent().apply {
            action = Intent.ACTION_OPEN_DOCUMENT
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        choosingFiles = true
        fileChooser = webView to callback
        try {
            selectFiles.launch(request)
        } catch (_: ActivityNotFoundException) {
            choosingFiles = false
            cancelFileChooser(webView)
        }
    }

    internal fun cancelFileChooser(webView: WebView) {
        val (owner, callback) = fileChooser ?: return
        if (owner !== webView) return
        fileChooser = null
        callback.onReceiveValue(null)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(CoxWorkspaceWebViewPlugin::class.java)
        try {
            registerPlugin(Class.forName("dev.doublepi.cox.mobile.CoxVaultPlugin").asSubclass(Plugin::class.java))
        } catch (_: ClassNotFoundException) {
            android.util.Log.i("CoxMobile", "Credential vault plugin is not installed")
        }
        super.onCreate(savedInstanceState)
        WorkspaceChrome.installWindowInsets(this)
        val background = WorkspaceChrome.defaultBackgroundColor(this)
        WorkspaceChrome.applySystemBars(this, background)
        bridge?.webView?.setBackgroundColor(background)
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
