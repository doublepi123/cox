package dev.doublepi.cox.mobile

import java.net.URI
import java.util.Locale

internal class GatewayHandoff(val identity: WorkspaceIdentity, gatewayLogin: Boolean) {
    private data class Ticket(val id: Long, val returnUrl: String, var started: Boolean = false)
    private var token: String? = null
    private var expectedUrl: String? = null
    private var gateway = gatewayLogin
    private var gatewayVisited = false
    private var sequence = 0L
    private var barrier: Ticket? = null

    private fun isGatewayChallenge(url: String): Boolean {
        val uri = try { URI(url) } catch (_: Exception) { return false }
        if (uri.scheme?.lowercase(Locale.ROOT) != "https" || uri.rawUserInfo != null) return false
        val host = uri.host?.lowercase(Locale.ROOT) ?: return false
        val path = uri.rawPath ?: ""
        return host.endsWith(".cloudflareaccess.com") ||
            (canonicalOrigin(url) == identity.origin && path.startsWith("/cdn-cgi/access/"))
    }

    fun route(url: String): String {
        if (!identity.permits(url)) return "block"
        if (isGatewayChallenge(url)) {
            token = null
            gateway = true
            return "load"
        }
        return if (canonicalOrigin(url) == identity.origin || (gateway && url.startsWith("https:"))) "load" else "external"
    }

    fun invalidate() { token = null }

    fun start(url: String): String? {
        token = null
        barrier?.let {
            if (url == "about:blank?cox-gateway=${it.id}") it.started = true
            return null
        }
        expectedUrl = url
        if (isGatewayChallenge(url)) gateway = true
        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { "" }
        if (gateway && (canonicalOrigin(url) != identity.origin || path.startsWith("/cdn-cgi/"))) gatewayVisited = true
        if (gateway && gatewayVisited && canonicalOrigin(url) == identity.origin && !path.startsWith("/cdn-cgi/")) {
            barrier = Ticket(++sequence, url)
            return "about:blank?cox-gateway=$sequence"
        }
        return null
    }

    fun finishBarrier(url: String): String? {
        val ticket = barrier ?: return null
        if (!ticket.started || url != "about:blank?cox-gateway=${ticket.id}") return null
        barrier = null
        gateway = false
        gatewayVisited = false
        expectedUrl = ticket.returnUrl
        return ticket.returnUrl
    }

    fun commit(url: String, freshToken: String): Boolean {
        val path = try { URI(url).rawPath ?: "" } catch (_: Exception) { return false }
        if (barrier != null || url != expectedUrl || canonicalOrigin(url) != identity.origin ||
            (gateway && (gatewayVisited || path.startsWith("/cdn-cgi/"))) ||
            !Regex("^[0-9a-f]{64}$").matches(freshToken)) return false
        gateway = false
        token = freshToken
        return true
    }

    fun accepts(origin: String, mainFrame: Boolean, suppliedToken: String): Boolean =
        mainFrame && origin == identity.origin && token != null && suppliedToken == token
}
