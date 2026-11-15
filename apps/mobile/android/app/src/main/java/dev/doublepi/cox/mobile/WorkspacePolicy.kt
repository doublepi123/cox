package dev.doublepi.cox.mobile

import java.net.URI
import java.security.MessageDigest
import java.util.Locale

internal data class WorkspaceIdentity(val profileId: String, val origin: String, val allowInsecureHttp: Boolean) {
    val profileName: String
        get() {
            val hash = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }
            return "cox_srv_${profileId.replace("-", "").lowercase(Locale.ROOT)}_$hash"
        }

    fun permits(url: String): Boolean {
        val uri = try { URI(url) } catch (_: java.net.URISyntaxException) { return false }
        return uri.rawUserInfo == null && uri.host != null &&
            (uri.scheme == "https" || (uri.scheme == "http" && allowInsecureHttp && origin.startsWith("http:")))
    }

    companion object {
        fun parse(id: String, input: String, insecure: Boolean): WorkspaceIdentity {
            require(Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$").matches(id))
            val uri = URI(input)
            val origin = canonicalOrigin(input)
            require(origin != null && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
            require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")
            require(origin.startsWith("https:") || insecure)
            return WorkspaceIdentity(id, origin, insecure)
        }
    }
}

internal fun canonicalOrigin(input: String): String? {
    val uri = try { URI(input) } catch (_: java.net.URISyntaxException) { return null }
    val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
    val host = uri.host?.lowercase(Locale.ROOT) ?: return null
    if (scheme != "https" && scheme != "http") return null
    if (uri.rawUserInfo != null || uri.port > 65535) return null
    val port = if (uri.port == -1 || (scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) "" else ":${uri.port}"
    return "$scheme://$host$port"
}

internal data class DownloadHop(val url: String, val cookiesAllowed: Boolean) {
    fun redirect(identity: WorkspaceIdentity, location: String): DownloadHop? {
        val target = try { URI(url).resolve(location).toString() } catch (_: IllegalArgumentException) { return null }
        if (!identity.permits(target) || (url.startsWith("https:") && target.startsWith("http:"))) return null
        return DownloadHop(target, cookiesAllowed && canonicalOrigin(target) == identity.origin)
    }
}

internal sealed interface OpenDecision {
    data object IsolationPanel : OpenDecision
    data class Workspace(val evicted: String?, val path: String) : OpenDecision
}

internal class WorkspacePoolPolicy {
    private val pool = linkedMapOf<String, String>()
    private val paths = mutableMapOf<String, String>()
    private val retired = mutableSetOf<String>()

    fun open(profileName: String, multiProfile: Boolean): OpenDecision {
        if (!multiProfile || profileName in retired) return OpenDecision.IsolationPanel
        val path = paths[profileName] ?: "/"
        pool.remove(profileName)
        val evicted = if (pool.size == 2) pool.keys.first() else null
        evicted?.let { pool.remove(it) }
        pool[profileName] = path
        return OpenDecision.Workspace(evicted, path)
    }

    fun remember(profileName: String, path: String) {
        if (profileName in pool && path.startsWith("/") && !path.startsWith("//")) paths[profileName] = path
    }

    fun forget(profileName: String): List<String> {
        retired.add(profileName)
        val pooled = pool.remove(profileName) != null
        paths.remove(profileName)
        return if (pooled) listOf("destroyWebView", "deleteProfile") else listOf("deleteProfile")
    }
}
