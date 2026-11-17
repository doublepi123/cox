import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import https from "node:https";
import http from "node:http";
import { serverSwitcher } from "./smoke-surfaces.mjs";
import { withDeadline } from "./smoke-runtime.mjs";

export const VIEWPORT = { width: 390, height: 844 };

function nativeGetNoRedirect(targetUrl, cookieHeader) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname:
          parsed.hostname === "cox.test" || parsed.hostname === "team.cloudflareaccess.com"
            ? "127.0.0.1"
            : parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        rejectUnauthorized: false,
        servername: parsed.hostname,
        headers: {
          host: parsed.host,
          accept: "application/json",
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
      },
      (res) => {
        const headers = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (key.toLowerCase() === "set-cookie" || value === undefined) continue;
          headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          res.resume();
          resolvePromise({ status, headers, body: "" });
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", rejectPromise);
        res.on("end", () => {
          resolvePromise({
            status,
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", rejectPromise);
    req.end();
  });
}

export async function installNativeWorkspace(launcher, browser, watchPage) {
  const contexts = new Map();
  const profiles = new Map();
  const gatewayApprovals = [];
  let opened = Promise.withResolvers();
  let switched = Promise.withResolvers();
  let activeProfileId = null;

  async function ensureProfileContext(profileId) {
    let context = contexts.get(profileId);
    if (!context) {
      context = await browser.newContext({
        viewport: VIEWPORT,
        isMobile: true,
        hasTouch: true,
        ignoreHTTPSErrors: true,
      });
      contexts.set(profileId, context);
    }
    return context;
  }

  await launcher.exposeBinding("coxNativeCall", async (_, plugin, method, payload) => {
    assert.equal(plugin, "CoxWorkspaceWebView");
    switch (method) {
      case "requestProfileUrl": {
        const context = await ensureProfileContext(payload.profileId);
        const cookies = await context.cookies(payload.url);
        const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
        return await nativeGetNoRedirect(payload.url, cookieHeader);
      }
      case "signInToGateway": {
        const context = await ensureProfileContext(payload.profileId);
        const gatePage = await context.newPage();
        try {
          await gatePage.goto(payload.origin, { waitUntil: "domcontentloaded" });
          await gatePage.getByRole("button", { name: "Approve Cloudflare Access" }).click();
          await gatePage.waitForURL(
            (url) => url.origin === payload.origin && !url.pathname.startsWith("/cdn-cgi/"),
            { timeout: 20_000 },
          );
          gatewayApprovals.push({ profileId: payload.profileId, origin: payload.origin });
        } finally {
          await gatePage.close();
        }
        return;
      }
      case "openWorkspace": {
        let workspace = profiles.get(payload.profileId);
        if (!workspace) {
          const context = await ensureProfileContext(payload.profileId);
          const page = await context.newPage();
          const bridgeToken = randomBytes(32).toString("hex");
          workspace = { context, page, bridgeToken, profile: payload };
          profiles.set(payload.profileId, workspace);
          watchPage(page, payload.label);
          await page.exposeBinding("coxShellMessage", async (_, message) => {
            assert.equal(message.bridgeToken, bridgeToken);
            switch (message.type) {
              case "openServerSwitcher":
                assert.equal(activeProfileId, payload.profileId);
                activeProfileId = null;
                await launcher.bringToFront();
                switched.resolve(payload.profileId);
                return;
              case "hapticSelection":
              case "syncThemeColor":
                return;
              default:
                throw new Error(`Unexpected mobile shell message: ${message.type}`);
            }
          });
          await page.addInitScript(
            ({ info, bridgeToken }) => {
              globalThis.__coxMobileShell__ = {
                info,
                bridgeToken,
                postMessage: (message) => globalThis.coxShellMessage(message),
              };
            },
            {
              info: {
                platform: "ios",
                activeServerLabel: payload.label,
                serverCount: payload.serverCount,
              },
              bridgeToken,
            },
          );
          activeProfileId = payload.profileId;
          await page.goto(new URL(payload.lastThreadPath ?? "/", payload.origin).href);
        }
        activeProfileId = payload.profileId;
        await workspace.page.bringToFront();
        opened.resolve(workspace);
        return;
      }
      case "forgetProfile": {
        const workspace = profiles.get(payload.profileId);
        profiles.delete(payload.profileId);
        const context = contexts.get(payload.profileId) ?? workspace?.context;
        contexts.delete(payload.profileId);
        if (context) await context.close();
        return;
      }
      default:
        throw new Error(`Unexpected workspace method: ${method}`);
    }
  });
  await launcher.addInitScript(() => {
    globalThis.CapacitorCustomPlatform = { name: "ios" };
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      PluginHeaders: [
        {
          name: "CoxWorkspaceWebView",
          methods: [
            { name: "requestProfileUrl", rtype: "promise" },
            { name: "signInToGateway", rtype: "promise" },
            { name: "openWorkspace", rtype: "promise" },
            { name: "closeWorkspace", rtype: "promise" },
            { name: "forgetProfile", rtype: "promise" },
            { name: "addListener", rtype: "callback" },
            { name: "removeListener", rtype: "promise" },
          ],
        },
      ],
      nativeCallback: () => "smoke-listener",
      nativePromise: (plugin, method, payload) => {
        if (method === "removeListener") return Promise.resolve();
        return globalThis.coxNativeCall(plugin, method, payload);
      },
    };
  });
  return {
    gatewayApprovals,
    prepareOpenWait() {
      opened = Promise.withResolvers();
      return () => withDeadline(opened.promise, 30_000, "Native workspace did not open.");
    },
    async connect(label) {
      assert.equal(activeProfileId, null, "Return through the Servers pill before connecting.");
      opened = Promise.withResolvers();
      await launcher
        .getByRole("listitem")
        .filter({ hasText: label })
        .getByRole("button", { name: "Connect", exact: true })
        .click();
      return await withDeadline(opened.promise, 30_000, `Native handoff never opened ${label}.`);
    },
    async switchToLauncher(workspace) {
      switched = Promise.withResolvers();
      await (await serverSwitcher(workspace.page)).click();
      assert.equal(
        await withDeadline(switched.promise, 20_000, "Servers pill did not return to launcher."),
        workspace.profile.profileId,
      );
    },
  };
}
