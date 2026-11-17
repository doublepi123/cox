import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { withDeadline } from "./smoke-runtime.mjs";

export const VIEWPORT = { width: 390, height: 844 };

export async function installNativeWorkspace(launcher, browser, watchPage) {
  const profiles = new Map();
  let opened = Promise.withResolvers();
  let switched = Promise.withResolvers();
  let activeProfileId = null;
  await launcher.exposeBinding("coxNativeCall", async (_, plugin, method, payload) => {
    assert.equal(plugin, "CoxWorkspaceWebView");
    switch (method) {
      case "openWorkspace": {
        let workspace = profiles.get(payload.profileId);
        if (!workspace) {
          const context = await browser.newContext({
            viewport: VIEWPORT,
            isMobile: true,
            hasTouch: true,
          });
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
        if (workspace) await workspace.context.close();
        profiles.delete(payload.profileId);
        return;
      }
      default:
        throw new Error(`Unexpected workspace method: ${method}`);
    }
  });
  await launcher.addInitScript(() => {
    globalThis.CapacitorCustomPlatform = { name: "ios" };
    globalThis.Capacitor = {
      PluginHeaders: [
        {
          name: "CoxWorkspaceWebView",
          methods: [
            { name: "openWorkspace", rtype: "promise" },
            { name: "forgetProfile", rtype: "promise" },
          ],
        },
      ],
      nativePromise: (plugin, method, payload) => globalThis.coxNativeCall(plugin, method, payload),
    };
  });
  return {
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
      await workspace.page.locator("[data-mobile-server-switcher]").click();
      assert.equal(
        await withDeadline(switched.promise, 20_000, "Servers pill did not return to launcher."),
        workspace.profile.profileId,
      );
    },
  };
}
