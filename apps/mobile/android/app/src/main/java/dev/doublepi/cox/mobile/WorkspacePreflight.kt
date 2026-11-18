package dev.doublepi.cox.mobile

import android.graphics.Bitmap
import android.graphics.Color
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.util.Locale

internal val PREFLIGHT_PATHS = setOf("/.well-known/t3/environment", "/api/auth/session")

internal fun validatePreflightTarget(identity: WorkspaceIdentity, requestUrl: String): URI {
    val uri = URI(requestUrl)
    require(identity.permits(requestUrl) && canonicalOrigin(requestUrl) == identity.origin)
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
    require(uri.rawPath in PREFLIGHT_PATHS)
    return uri
}

internal class WorkspacePreflight(
    private val plugin: CoxWorkspaceWebViewPlugin,
    private val evictPooledView: (String) -> Unit,
    private val restoreLauncherBars: () -> Unit,
) {
    private var signInOverlay: FrameLayout? = null
    private var signInWebView: WebView? = null
    private var backCallback: OnBackPressedCallback? = null
    internal val hasActiveSignIn: Boolean
        get() = signInOverlay != null

    private fun verifyLauncherCaller() {
        val page = URI(plugin.bridge.webView.url ?: "")
        require(page.scheme == "https" && page.host == "localhost")
    }

    fun requestProfileUrl(call: PluginCall) {
        plugin.activity.runOnUiThread {
            try {
                verifyLauncherCaller()
                val identity = WorkspaceIdentity.parse(
                    requireNotNull(call.getString("profileId")),
                    requireNotNull(call.getString("origin")),
                    call.getBoolean("allowInsecureHttp", false) == true,
                )
                val requestUrl = requireNotNull(call.getString("url"))
                val targetUri = validatePreflightTarget(identity, requestUrl)
                val cookieHeader = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
                    ProfileStore.getInstance().getOrCreateProfile(identity.profileName)
                        .cookieManager.getCookie(requestUrl)
                } else null
                Thread {
                    try {
                        val connection = targetUri.toURL().openConnection()
                        require(connection is HttpURLConnection)
                        val payload = try {
                            connection.instanceFollowRedirects = false
                            connection.connectTimeout = 15_000
                            connection.readTimeout = 15_000
                            connection.requestMethod = "GET"
                            connection.setRequestProperty("Accept", "application/json")
                            if (!cookieHeader.isNullOrBlank()) {
                                connection.setRequestProperty("Cookie", cookieHeader)
                            }
                            val status = connection.responseCode
                            val headers = JSObject()
                            for ((key, values) in connection.headerFields) {
                                if (key == null || key.equals("set-cookie", ignoreCase = true)) continue
                                headers.put(key.lowercase(Locale.ROOT), values.joinToString(", "))
                            }
                            val body = if (status in 300..399) "" else {
                                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                                stream?.use { input ->
                                    val bytes = input.readNBytes(1_000_001)
                                    String(bytes, Charsets.UTF_8)
                                } ?: ""
                            }
                            JSObject().put("status", status).put("headers", headers).put("body", body)
                        } finally {
                            connection.disconnect()
                        }
                        plugin.activity.runOnUiThread { call.resolve(payload) }
                    } catch (error: Exception) {
                        plugin.activity.runOnUiThread {
                            call.reject("The server could not be reached.", "network_error", error)
                        }
                    }
                }.start()
            } catch (error: Exception) {
                call.reject("Invalid preflight request.", "invalid_request", error)
            }
        }
    }

    fun signInToGateway(call: PluginCall) {
        plugin.activity.runOnUiThread {
            try {
                verifyLauncherCaller()
                require(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
                val identity = WorkspaceIdentity.parse(
                    requireNotNull(call.getString("profileId")),
                    requireNotNull(call.getString("origin")),
                    false,
                )
                require(identity.origin.startsWith("https://"))
                closeSignIn()
                evictPooledView(identity.profileName)
                val activity = plugin.activity
                val profile = ProfileStore.getInstance().getOrCreateProfile(identity.profileName)
                val webView = WebView(activity)
                WebViewCompat.setProfile(webView, identity.profileName)
                check(WebViewCompat.getProfile(webView).name == identity.profileName)
                webView.settings.apply {
                    javaScriptEnabled = true
                    domStorageEnabled = true
                    mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                    allowFileAccess = false
                    allowContentAccess = false
                    setSupportMultipleWindows(false)
                    javaScriptCanOpenWindowsAutomatically = false
                }
                var settled = false
                var failedMainUrl: String? = null
                val finish = { errorCode: String?, errorMessage: String? ->
                    if (!settled) {
                        settled = true
                        profile.cookieManager.flush()
                        closeSignIn()
                        if (errorCode == null) call.resolve()
                        else call.reject(errorMessage ?: "Cloudflare Access sign-in failed.", errorCode)
                    }
                }
                webView.webViewClient = object : WebViewClient() {
                    private fun permitsHttps(url: String): Boolean {
                        val uri = try { URI(url) } catch (_: Exception) { return false }
                        return uri.scheme?.lowercase(Locale.ROOT) == "https" &&
                            uri.host != null && uri.rawUserInfo == null
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        return !permitsHttps(request.url.toString())
                    }

                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        if (permitsHttps(request.url.toString())) return null
                        return WebResourceResponse(
                            "text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0))
                        )
                    }

                    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                        failedMainUrl = null
                        if (!permitsHttps(url)) view.stopLoading()
                    }

                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        if (request.isForMainFrame) failedMainUrl = request.url.toString()
                    }

                    override fun onPageFinished(view: WebView, url: String) {
                        if (settled || view.url != url || failedMainUrl == url) return
                        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { return }
                        if (canonicalOrigin(url) == identity.origin && !path.startsWith("/cdn-cgi/")) {
                            finish(null, null)
                        }
                    }
                }
                val density = activity.resources.displayMetrics.density
                val pad = (12 * density).toInt()
                val isZh = Locale.getDefault().language.lowercase(Locale.ROOT).startsWith("zh")
                val headerColor = Color.parseColor("#151518")
                webView.setBackgroundColor(headerColor)
                val header = LinearLayout(activity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setBackgroundColor(headerColor)
                    setPadding(pad, (8 * density).toInt(), pad, (8 * density).toInt())
                }
                header.addView(TextView(activity).apply {
                    text = "Cloudflare Access"
                    setTextColor(Color.parseColor("#F5F5F5"))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                }, LinearLayout.LayoutParams(0, -2, 1f))
                header.addView(TextView(activity).apply {
                    text = if (isZh) "取消" else "Cancel"
                    gravity = Gravity.CENTER
                    minHeight = (34 * density).toInt()
                    setPadding((14 * density).toInt(), 0, (14 * density).toInt(), 0)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    WorkspaceChrome.styleCapsuleControl(this, false)
                    setOnClickListener { finish("gateway_cancelled", "Cloudflare Access sign-in was cancelled.") }
                })
                val layout = LinearLayout(activity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(header, LinearLayout.LayoutParams(-1, -2))
                    addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
                }
                val root = FrameLayout(activity).apply {
                    setBackgroundColor(headerColor)
                    fitsSystemWindows = false
                    isClickable = true
                    addView(layout, FrameLayout.LayoutParams(-1, -1))
                }
                WorkspaceChrome.installChildWebViewInsetsShield(root)
                WorkspaceChrome.applySystemBars(activity, headerColor)
                if (activity is ComponentActivity) {
                    val callback = object : OnBackPressedCallback(true) {
                        override fun handleOnBackPressed() {
                            if (webView.canGoBack()) webView.goBack()
                            else finish("gateway_cancelled", "Cloudflare Access sign-in was cancelled.")
                        }
                    }
                    activity.onBackPressedDispatcher.addCallback(activity, callback)
                    backCallback = callback
                }
                signInWebView = webView
                signInOverlay = root
                activity.addContentView(root, ViewGroup.LayoutParams(-1, -1))
                webView.loadUrl(identity.origin)
            } catch (error: Exception) {
                closeSignIn()
                call.reject("Cloudflare Access sign-in could not be opened.", "gateway_unavailable", error)
            }
        }
    }

    fun closeSignIn() {
        val hadOverlay = signInOverlay != null
        backCallback?.remove()
        backCallback = null
        signInWebView?.let { view ->
            (view.parent as? ViewGroup)?.removeView(view)
            view.stopLoading()
            view.destroy()
        }
        signInWebView = null
        signInOverlay?.let { root ->
            root.removeAllViews()
            (root.parent as? ViewGroup)?.removeView(root)
        }
        signInOverlay = null
        if (hadOverlay) {
            restoreLauncherBars()
        }
    }
}
