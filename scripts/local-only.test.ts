import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = NodePath.resolve(import.meta.dirname, "..");

describe("local-only distribution boundary", () => {
  it("keeps the desktop startup page free of backend status copy", () => {
    const main = NodeFS.readFileSync(
      NodePath.join(root, "apps/desktop/src/startup-page.ts"),
      "utf8",
    );
    expect(main).toContain("<h1>Cox</h1>");
    expect(main).not.toContain("Starting local backend");
    expect(main).not.toContain("正在启动本地后端");
    expect(main).toContain("prefers-reduced-motion");
    expect(main).toContain("cox-pulse");
  });

  it("signs macOS test packages and verifies the distributable signatures before smoke", () => {
    const packaging = NodeFS.readFileSync(
      NodePath.join(root, "apps/desktop/scripts/package.ts"),
      "utf8",
    );
    expect(packaging).toContain("{ identity: process.env.CSC_NAME }");
    expect(packaging).toContain(': { identity: "-" }');
    const workflow = NodeFS.readFileSync(
      NodePath.join(root, ".github/workflows/desktop.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm --filter @cox/desktop verify:mac");
    expect(workflow.indexOf("verify:mac")).toBeLessThan(workflow.indexOf("@cox/desktop smoke"));
    const verification = NodeFS.readFileSync(
      NodePath.join(root, "apps/desktop/scripts/verify-mac.ts"),
      "utf8",
    );
    expect(verification).toContain('"--deep", "--strict"');
    expect(verification).toContain("`${basename}.zip`");
    expect(verification).toContain("`${basename}.dmg`");
    expect(verification).toContain('"detach", mounted');
  });

  it("installs the Electron runtime explicitly before desktop startup and packaging", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(root, "apps/desktop/package.json"), "utf8"),
    );
    expect(manifest.scripts["electron:install"]).toBe("install-electron");
    expect(manifest.scripts.dev).toContain("pnpm electron:install &&");
    expect(manifest.scripts.package).toBe("pnpm electron:install && node scripts/package.ts");
  });

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

  it("keeps startup and CLI authentication free of pairing", () => {
    for (const relative of [
      "apps/server/src/cli/auth.ts",
      "apps/server/src/cliAuthFormat.ts",
      "apps/server/src/startupAccess.ts",
      "apps/server/src/serverRuntimeStartup.ts",
    ]) {
      const source = NodeFS.readFileSync(NodePath.join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/pairing|buildPairingUrl|issueStartupPairing/i);
    }
    const config = NodeFS.readFileSync(
      NodePath.join(root, "apps/server/src/cli/config.ts"),
      "utf8",
    );
    expect(config).not.toContain("DevAuthTokenConfig");
  });

  it("does not ship removed application or infrastructure surfaces", () => {
    for (const directory of [
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

  it("isolates the desktop shell and keeps mobile and cloud dependencies out of manifests", () => {
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
        if (
          relative === NodePath.join("apps", "desktop", "package.json") &&
          /^(?:electron(?:-|$)|@electron\/)/.test(name)
        )
          continue;
        expect(forbidden.test(name), `${relative}: ${name}`).toBe(false);
      }
    }
  });
});
