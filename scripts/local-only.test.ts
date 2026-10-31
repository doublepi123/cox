import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");

describe("local-only distribution boundary", () => {
  it("retains only the browser fixes in the Legend list patch", () => {
    const patch = NodeFS.readFileSync(
      NodePath.join(root, "patches/@legendapp__list@3.3.5.patch"),
      "utf8",
    );
    const targets = [...patch.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((match) => match[1]);
    expect(targets).toEqual(["react.js", "react.mjs"]);
    expect(patch).toContain("moveChildBefore");
    expect(patch).toContain("didChangeIndex");
  });

  it("does not ship removed application or infrastructure surfaces", () => {
    for (const directory of [
      "apps/desktop",
      "apps/mobile",
      "apps/marketing",
      "infra",
      ".repos",
      "packages/ssh",
      "packages/tailscale",
      "apps/server/src/cloud",
      "apps/server/src/relay",
      "apps/server/src/device",
      "apps/server/src/peer",
      "apps/server/src/desktopUpdate",
      "apps/server/src/guest",
      "apps/server/src/cli/consoleStdin.ts",
      "packages/contracts/src/desktopBrowser.ts",
      "packages/contracts/src/desktopBootstrap.ts",
      "packages/contracts/src/desktopAppActivation.ts",
      "packages/contracts/src/device.ts",
      "packages/contracts/src/relay.ts",
      "packages/contracts/src/relayClient.ts",
      "packages/contracts/src/peerLink.ts",
    ]) {
      expect(NodeFS.existsSync(NodePath.join(root, directory)), directory).toBe(false);
    }
  });

  it("keeps desktop, native-client and cloud-account dependencies out of workspace manifests", () => {
    const manifests = ["package.json", "scripts/package.json"];
    for (const directory of ["apps", "packages"]) {
      for (const entry of NodeFS.readdirSync(NodePath.join(root, directory))) {
        const relative = NodePath.join(directory, entry, "package.json");
        if (NodeFS.existsSync(NodePath.join(root, relative))) manifests.push(relative);
      }
    }
    const forbidden =
      /^(?:@clerk\/|@expo\/|expo(?:-|$)|electron(?:-|$)|@electron\/|react-native(?:-|$)|@react-native\/|@react-navigation\/|@t3tools\/(?:ssh|tailscale)$|alchemy$|@alchemy\.run\/)/;
    for (const relative of manifests) {
      const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(root, relative), "utf8"));
      const dependencies = {
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
      };
      for (const name of Object.keys(dependencies)) {
        expect(forbidden.test(name), `${relative}: ${name}`).toBe(false);
      }
    }
  });
});
