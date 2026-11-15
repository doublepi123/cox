package dev.doublepi.cox.mobile

import java.net.URI

internal class GatewayHandoff(val identity: WorkspaceIdentity, gatewayLogin: Boolean) {
    private data class Ticket(val id: Long, val returnUrl: String, var started: Boolean = false)
    private var token: String? = null
    private var expectedUrl: String? = null
    private var gateway = gatewayLogin
    private var gatewayVisited = false
    private var sequence = 0L
    private var barrier: Ticket? = null

    fun route(url: String): String {
        if (!identity.permits(url)) return "block"
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
        if (gateway && (canonicalOrigin(url) != identity.origin || URI(url).path.startsWith("/cdn-cgi/"))) gatewayVisited = true
        if (gateway && gatewayVisited && canonicalOrigin(url) == identity.origin && !URI(url).path.startsWith("/cdn-cgi/")) {
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
        expectedUrl = ticket.returnUrl
        return ticket.returnUrl
    }

    fun commit(url: String, freshToken: String): Boolean {
        if (barrier != null || url != expectedUrl || canonicalOrigin(url) != identity.origin ||
            (gateway && (gatewayVisited || URI(url).path.startsWith("/cdn-cgi/"))) ||
            !Regex("^[0-9a-f]{64}$").matches(freshToken)) return false
        gateway = false
        token = freshToken
        return true
    }

    fun accepts(origin: String, mainFrame: Boolean, suppliedToken: String): Boolean =
        mainFrame && origin == identity.origin && token != null && suppliedToken == token
}
