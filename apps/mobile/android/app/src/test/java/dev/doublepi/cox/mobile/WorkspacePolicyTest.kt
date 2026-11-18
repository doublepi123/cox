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

    @Test fun midSessionCloudflareAccessExpiryReentersBarrierAndRejectsLookalikeHost() {
        val policy = GatewayHandoff(identity, false)
        val initial = "${identity.origin}/threads/1"
        val firstToken = "a".repeat(64)
        policy.start(initial)
        assertTrue(policy.commit(initial, firstToken))
        assertEquals("external", policy.route("https://evilcloudflareaccess.com/login"))

        val cfChallenge = "https://broad-sun-37d6.cloudflareaccess.com/cdn-cgi/access/login/dd.yang.sarl"
        assertEquals("load", policy.route(cfChallenge))
        assertFalse(policy.accepts(identity.origin, true, firstToken))
        assertNull(policy.start(cfChallenge))
        assertEquals("load", policy.route("https://accounts.example/sso"))
        assertNull(policy.start("https://accounts.example/sso"))
        assertFalse(policy.commit("https://accounts.example/sso", "b".repeat(64)))

        val authorized = "${identity.origin}/cdn-cgi/access/authorized?nonce=1"
        assertEquals("load", policy.route(authorized))
        assertNull(policy.start(authorized))
        assertFalse(policy.commit(authorized, "b".repeat(64)))

        val blank = requireNotNull(policy.start(initial))
        policy.start(blank)
        assertEquals(initial, policy.finishBarrier(blank))
        policy.start(initial)
        val renewedToken = "c".repeat(64)
        assertTrue(policy.commit(initial, renewedToken))
        assertTrue(policy.accepts(identity.origin, true, renewedToken))
        assertEquals("external", policy.route("https://accounts.example/sso"))
    }

    @Test fun preflightTargetAllowsOnlyCanonicalAdmissionEndpoints() {
        assertEquals("/.well-known/t3/environment", validatePreflightTarget(identity, "${identity.origin}/.well-known/t3/environment").rawPath)
        assertEquals("/api/auth/session", validatePreflightTarget(identity, "${identity.origin}/api/auth/session").rawPath)
        for (rejected in listOf(
            "${identity.origin}/api/projects",
            "${identity.origin}/.well-known/t3/environment?x=1",
            "https://other:3773/.well-known/t3/environment",
            "http://host:3773/.well-known/t3/environment",
        )) {
            assertThrows(IllegalArgumentException::class.java) {
                validatePreflightTarget(identity, rejected)
            }
        }
    }

    @Test fun systemBackAtTheWorkspaceRootReturnsToTheConnectionManager() {
        assertEquals(WorkspaceSystemBack.History, workspaceSystemBack(canGoBack = true))
        assertEquals(WorkspaceSystemBack.ConnectionManager, workspaceSystemBack(canGoBack = false))
        assertEquals("0px", safeAreaCssPixels(0, 2.75f))
        assertEquals("24.00px", safeAreaCssPixels(66, 2.75f))
        assertEquals("0px", safeAreaCssPixels(48, 0f))
    }
}
