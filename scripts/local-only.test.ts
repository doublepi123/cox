import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");

describe("local-only distribution boundary", () => {
  it("uses a single Cox SVG for the favicon, splash and in-app icon", () => {
    const html = NodeFS.readFileSync(NodePath.join(root, "apps/web/index.html"), "utf8");
    const component = NodeFS.readFileSync(
      NodePath.join(root, "apps/web/src/components/CoxAppIcon.tsx"),
      "utf8",
    );
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "apps/web/public/manifest.webmanifest"), "utf8"),
    );
    expect(html).toContain('href="/cox.svg"');
    expect(html).toContain('id="boot-shell-logo" src="/cox.svg"');
    expect(component).toContain('src="/cox.svg" alt="Cox"');
    expect(manifest.icons).toEqual([
      { src: "/cox.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });

  it("ships Cox PNG sizes and a valid multi-resolution ICO fallback", () => {
    for (const [filename, size] of [
      ["favicon-16x16.png", 16],
      ["favicon-32x32.png", 32],
      ["apple-touch-icon.png", 180],
      ["icon-192.png", 192],
      ["icon-512.png", 512],
    ] as const) {
      const image = NodeFS.readFileSync(NodePath.join(root, "apps/web/public", filename));
      expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(image.readUInt32BE(16), filename).toBe(size);
      expect(image.readUInt32BE(20), filename).toBe(size);
    }
    const ico = NodeFS.readFileSync(NodePath.join(root, "apps/web/public/favicon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    for (const index of [0, 1]) {
      const offset = 6 + index * 16;
      const start = ico.readUInt32LE(offset + 12);
      const length = ico.readUInt32LE(offset + 8);
      expect(start + length).toBeLessThanOrEqual(ico.length);
      expect(ico.subarray(start, start + 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });

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
