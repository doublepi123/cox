package dev.doublepi.cox.mobile

import android.app.Activity
import android.graphics.Bitmap
import android.net.Uri
import android.view.HapticFeedbackConstants
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom

internal data class WorkspaceOptions(
    val identity: WorkspaceIdentity,
    val label: String,
    val serverCount: Int,
    val gatewayLogin: Boolean,
)

internal interface WorkspaceHost {
    val activity: Activity
    val downloads: WorkspaceDownloads
    fun launchEvent(event: String)
    fun remember(identity: WorkspaceIdentity, path: String)
    fun rendererGone(profileName: String)
    fun openExternal(url: String)
    fun onWorkspaceChromeChanged(profileName: String, backgroundColor: Int)
    fun onWebSwitcherChanged(profileName: String, mounted: Boolean)
}

internal class WorkspaceView(private val host: WorkspaceHost, val options: WorkspaceOptions) {
    val identity = options.identity
    private val navigation = GatewayHandoff(identity, options.gatewayLogin)
    private val profile = ProfileStore.getInstance().getOrCreateProfile(identity.profileName)
    val webView = WebView(host.activity)
    var currentBackgroundColor: Int = WorkspaceChrome.defaultBackgroundColor(host.activity)
        private set
    var webSwitcherMounted: Boolean = false
        private set
    private var token: String? = null
    private var destroyed = false

    init {
        try {
            webView.setBackgroundColor(currentBackgroundColor)
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
            profile.cookieManager.setAcceptThirdPartyCookies(webView, false)
            webView.webViewClient = Client()
            WebViewCompat.addWebMessageListener(webView, "coxMobileShell", setOf(identity.origin)) {
                    _, message, sourceOrigin, mainFrame, _ ->
                if (!destroyed && webView.parent != null && message.type == WebMessageCompat.TYPE_STRING)
                    receive(message.data, canonicalOrigin(sourceOrigin.toString()) ?: "", mainFrame)
            }
            webView.setDownloadListener { url, _, _, _, _ ->
                if (!destroyed && identity.permits(url)) host.downloads.download(
                    DownloadBinding(identity, profile.cookieManager), url, "",
                )
                else if (!destroyed && token != null && url.startsWith("blob:")) saveBlobUrl(url)
            }
        } catch (error: Exception) {
            webView.destroy()
            throw error
        }
    }

    fun load(path: String) {
        val target = Uri.parse(identity.origin).buildUpon().encodedPath("/").build().toString()
        val url = if (path.startsWith("/") && !path.startsWith("//") && !path.contains('\\')) identity.origin + path else target
        require(identity.permits(url) && canonicalOrigin(url) == identity.origin)
        webView.loadUrl(url)
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        token = null
        navigation.invalidate()
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.stopLoading()
        WebViewCompat.removeWebMessageListener(webView, "coxMobileShell")
        webView.destroy()
    }

    private fun applyBackgroundColor(parsed: Int) {
        currentBackgroundColor = parsed
        webView.setBackgroundColor(parsed)
        host.onWorkspaceChromeChanged(identity.profileName, parsed)
    }

    fun refreshChromeProbe() {
        if (destroyed || token == null) return
        webView.evaluateJavascript(
            """
            (() => {
              if (window !== window.top || location.origin !== ${JSONObject.quote(identity.origin)}) return null;
              const probe = (raw) => {
                if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return null;
                const c = document.createElement("canvas");
                c.width = c.height = 1;
                const ctx = c.getContext("2d");
                if (!ctx) return null;
                ctx.fillStyle = raw;
                ctx.fillRect(0, 0, 1, 1);
                const d = ctx.getImageData(0, 0, 1, 1).data;
                if (d[3] === 0) return null;
                return "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
              };
              const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
              const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null;
              const rootBg = document.documentElement ? getComputedStyle(document.documentElement).backgroundColor : null;
              const hex = probe(bodyBg) || probe(rootBg) || probe(meta);
              return JSON.stringify({ hex });
            })()
            """.trimIndent(),
        ) { rawResult ->
            if (destroyed || token == null || rawResult == null || rawResult == "null") return@evaluateJavascript
            try {
                val decoded = org.json.JSONTokener(rawResult).nextValue() as? String ?: return@evaluateJavascript
                val obj = JSONObject(decoded)
                val hex = obj.optString("hex", "")
                parseHexColor(hex)?.let(::applyBackgroundColor)
            } catch (_: Exception) {
            }
        }
    }

    private fun receive(raw: String?, origin: String, mainFrame: Boolean) {
        if (raw == null || raw.length > ((WorkspaceDownloads.MAX_BYTES + 2) / 3) * 4 + 8192) return
        val message = try { JSONObject(raw) } catch (_: org.json.JSONException) { return }
        if (!navigation.accepts(origin, mainFrame, message.optString("bridgeToken"))) return
        when (message.optString("type")) {
            "openServerSwitcher", "openConnectionManager" -> host.launchEvent(message.getString("type"))
            "setServerSwitcherProvided" -> {
                if (!message.has("provided")) return
                val provided = message.optBoolean("provided")
                if (webSwitcherMounted != provided) {
                    webSwitcherMounted = provided
                    host.onWebSwitcherChanged(identity.profileName, provided)
                }
            }
            "hapticSelection" -> webView.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
            "syncThemeColor" -> {
                val rawColor = message.optString("color")
                val direct = parseHexColor(rawColor)
                if (direct != null) {
                    applyBackgroundColor(direct)
                } else {
                    refreshChromeProbe()
                }
            }
            "saveBlobDownload" -> {
                val data = message.opt("dataUrl") as? String ?: return
                val filename = message.opt("filename") as? String ?: return
                val mimeType = message.opt("mimeType") as? String ?: return
                if (filename.length !in 1..255 || mimeType.length > 128) return
                try { host.downloads.saveBlob(identity, data, filename) }
                catch (_: IllegalArgumentException) { android.widget.Toast.makeText(host.activity, "Invalid download", android.widget.Toast.LENGTH_SHORT).show() }
            }
        }
    }

    private fun inject(url: String) {
        val freshToken = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        if (destroyed || webView.url != url || !navigation.commit(url, freshToken)) return
        token = freshToken
        val info = JSONObject().put("platform", "android").put("activeServerLabel", options.label).put("serverCount", options.serverCount)
        val script = """
            (() => {
              if (window !== window.top || location.origin !== ${JSONObject.quote(identity.origin)}) return;
              const bridgeToken = ${JSONObject.quote(freshToken)};
              const post = payload => window.coxMobileShell.postMessage(typeof payload === "string" ? payload : JSON.stringify(payload));
              window.__coxMobileShell__ = {
                info: $info,
                bridgeToken,
                postMessage: post
              };
              window.dispatchEvent(new Event("cox:mobile-shell-change"));
              const sync = () => {
                const probe = (raw) => {
                  if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return null;
                  const c = document.createElement("canvas");
                  c.width = c.height = 1;
                  const ctx = c.getContext("2d");
                  if (!ctx) return null;
                  ctx.fillStyle = raw;
                  ctx.fillRect(0, 0, 1, 1);
                  const d = ctx.getImageData(0, 0, 1, 1).data;
                  if (d[3] === 0) return null;
                  return "#" + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, "0")).join("");
                };
                const bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : null;
                const rootBg = document.documentElement ? getComputedStyle(document.documentElement).backgroundColor : null;
                const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
                const hex = probe(bodyBg) || probe(rootBg) || probe(meta);
                if (hex) post({ type: "syncThemeColor", color: hex, bridgeToken });
              };
              sync();
              if (!window.__coxChromeObserverInstalled__) {
                window.__coxChromeObserverInstalled__ = true;
                let timer = 0;
                const schedule = () => {
                  clearTimeout(timer);
                  timer = setTimeout(sync, 40);
                };
                new MutationObserver(schedule).observe(document.documentElement, {
                  attributes: true,
                  subtree: true,
                  childList: true,
                  attributeFilter: ["class", "style", "data-theme-id", "content"]
                });
              }
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
        refreshChromeProbe()
        remember(url)
    }

    private fun remember(url: String) {
        if (token == null || canonicalOrigin(url) != identity.origin) return
        val uri = Uri.parse(url)
        val path = (uri.encodedPath?.ifEmpty { "/" } ?: "/") +
            (uri.encodedQuery?.let { "?$it" } ?: "") + (uri.encodedFragment?.let { "#$it" } ?: "")
        host.remember(identity, path)
    }

    private fun saveBlobUrl(url: String) {
        webView.evaluateJavascript("""
            (async () => {
              try {
                const response = await fetch(${JSONObject.quote(url)});
                const blob = await response.blob();
                if (blob.size > ${WorkspaceDownloads.MAX_BYTES}) throw new Error("Download exceeds 16 MiB");
                const dataUrl = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(reader.result);
                  reader.onerror = () => reject(reader.error);
                  reader.readAsDataURL(blob);
                });
                const shell = window.__coxMobileShell__;
                shell.postMessage({ type: "saveBlobDownload", bridgeToken: shell.bridgeToken,
                  dataUrl, filename: "download", mimeType: blob.type });
              } catch (error) { console.warn("Cox blob download could not be saved"); }
            })();
        """.trimIndent(), null)
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            if (!request.isForMainFrame) return !identity.permits(url)
            return when (navigation.route(url)) {
                "load" -> { token = null; navigation.invalidate(); false }
                "external" -> {
                    host.openExternal(url)
                    true
                }
                else -> true
            }
        }

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url.toString()
            if (identity.permits(url)) return null
            return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            token = null
            if (webSwitcherMounted) {
                webSwitcherMounted = false
                host.onWebSwitcherChanged(identity.profileName, false)
            }
            val blank = navigation.start(url)
            if (blank != null) {
                view.stopLoading()
                view.loadUrl(blank)
            } else if (!url.startsWith("about:blank?cox-gateway=") && navigation.route(url) != "load") {
                view.stopLoading()
            }
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (destroyed || view.url != url) return
            val next = navigation.finishBarrier(url)
            if (next != null) {
                view.loadUrl(next)
            } else {
                refreshChromeProbe()
            }
        }

        override fun onPageCommitVisible(view: WebView, url: String) { inject(url) }

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            remember(url)
            refreshChromeProbe()
        }

        override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
            destroy()
            host.rendererGone(identity.profileName)
            return true
        }
    }
}
