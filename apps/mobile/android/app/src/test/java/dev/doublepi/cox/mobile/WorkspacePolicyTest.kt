package dev.doublepi.cox.mobile

import org.junit.Assert.*
import org.junit.Test

class WorkspacePolicyTest {
    private val identity = WorkspaceIdentity.parse("f0407592-d23a-4e46-8f02-b7050b8c3299", "https://host:3773", false)

    @Test fun profilesSeparatePortsAndNormalizeDefaultPorts() {
        assertNotEquals(identity.profileName, identity.copy(origin = "https://host:3774").profileName)
        assertTrue(identity.profileName.matches(Regex("cox_srv_[0-9a-f]{32}_[0-9a-f]{64}")))
        assertEquals("https://host", canonicalOrigin("https://HOST:443/"))
    }

    @Test fun unsupportedIsolationDoesNotConsumePoolSlots() {
        val pool = WorkspacePoolPolicy()
        assertEquals(OpenDecision.IsolationPanel, pool.open("a", false))
        pool.open("b", true)
        assertEquals(OpenDecision.Workspace(null, "/"), pool.open("c", true))
    }

    @Test fun poolRetainsPathsAcrossEvictionAndRetiresBeforeDeletion() {
        val pool = WorkspacePoolPolicy()
        pool.open("a", true)
        pool.remember("a", "/threads/alpha")
        pool.open("b", true)
        pool.remember("b", "/threads/beta")
        pool.open("a", true)
        assertEquals(OpenDecision.Workspace("b", "/"), pool.open("c", true))
        assertEquals(OpenDecision.Workspace("a", "/threads/beta"), pool.open("b", true))
        assertEquals(listOf("destroyWebView", "deleteProfile"), pool.forget("b"))
        assertEquals(OpenDecision.IsolationPanel, pool.open("b", true))
    }

    @Test fun downloadsLoseCookiesPermanentlyOnForeignRedirect() {
        val initial = DownloadHop("${identity.origin}/download", true)
        assertEquals(DownloadHop("${identity.origin}/file", true), initial.redirect(identity, "/file"))
        val foreign = requireNotNull(initial.redirect(identity, "https://host:3774/file"))
        assertFalse(foreign.cookiesAllowed)
        assertFalse(requireNotNull(foreign.redirect(identity, "${identity.origin}/back")).cookiesAllowed)
        assertNull(initial.redirect(identity, "http://host:3773/file"))
    }

    @Test fun bridgeRejectsStaleForeignAndSubframeMessages() {
        val policy = GatewayHandoff(identity, false)
        val url = "${identity.origin}/threads/a"
        val token = "a".repeat(64)
        policy.start(url)
        assertTrue(policy.commit(url, token))
        assertTrue(policy.accepts(identity.origin, true, token))
        assertFalse(policy.accepts(identity.origin, false, token))
        assertFalse(policy.accepts("https://host:3774", true, token))
        policy.start(url)
        assertFalse(policy.accepts(identity.origin, true, token))
        assertTrue(policy.commit(url, "b".repeat(64)))
        assertFalse(policy.accepts(identity.origin, true, token))
    }

    @Test fun gatewayRequiresItsExactStartedBlankTicket() {
        val policy = GatewayHandoff(identity, true)
        val target = "${identity.origin}/threads/a"
        policy.start("https://login.example/login")
        val blank = requireNotNull(policy.start(target))
        assertNull(policy.finishBarrier(blank))
        assertFalse(policy.commit(target, "a".repeat(64)))
        policy.start(blank)
        assertNull(policy.finishBarrier("about:blank?cox-gateway=2"))
        assertEquals(target, policy.finishBarrier(blank))
        assertNull(policy.finishBarrier(blank))
        policy.start(target)
        assertTrue(policy.commit(target, "b".repeat(64)))
        assertEquals("external", policy.route("https://login.example/login"))
    }
}
