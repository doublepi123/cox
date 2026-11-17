import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect } from "vite-plus/test";

const forbiddenMobileDependencies =
  /^(?:electron(?:-|$)|@electron\/|expo(?:-|$)|@expo\/|react-native(?:-|$)|@react-native\/|@clerk\/|node-pty(?:-|$)|@t3tools\/(?:ssh|tailscale)$|alchemy$|@alchemy\.run\/)/;

export function assertMobileManifestIsLocalOnly(manifest: {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}): void {
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };
  const forbidden = Object.keys(dependencies).find((name) =>
    forbiddenMobileDependencies.test(name),
  );
  expect(forbidden, `apps/mobile/package.json: ${forbidden}`).toBeUndefined();
}

export function assertMobileDirectoryIsRemoteOnly(mobile: string): void {
  const ignoredDirectories = new Set(["node_modules", "dist", "build", "Pods", ".gradle"]);
  const runtimeDirectories = new Set(["src", "ios", "android"]);
  const spawnerPath = /(?:local[-/]?backend|backend[-/]?spawner|spawn[-/]?backend)/i;
  const rootfsArchive = /(?:proot|alpine).*\.(?:tar(?:\.(?:gz|xz|bz2|zst))?|tgz|zip|img)$/i;
  const spawnerCapability =
    /["'`](?:node:)?child_process["'`]|["'`]node-pty["'`]|\bProcessBuilder\s*\(|\bRuntime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(|\bposix_spawn(?:p)?\s*\(|\bNSTask\b|\bBackendProcess\b|apps\/server\/dist/;
  const pending = [mobile];
  for (const directory of pending) {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const absolute = NodePath.join(directory, entry.name);
      const relative = NodePath.relative(mobile, absolute).split(NodePath.sep).join("/");
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        if (directory === mobile && !runtimeDirectories.has(entry.name)) continue;
        pending.push(absolute);
      } else if (entry.isFile() && !/\.(?:test|spec)\./.test(entry.name)) {
        expect(spawnerPath.test(relative) || rootfsArchive.test(relative), relative).toBe(false);
        expect(NodeFS.readFileSync(absolute, "utf8"), relative).not.toMatch(spawnerCapability);
      }
    }
  }
}

export function assertDistributionManifestsAreLocalOnly(root: string): void {
  const manifests = ["package.json", "scripts/package.json"];
  for (const directory of ["apps", "packages"]) {
    for (const entry of NodeFS.readdirSync(NodePath.join(root, directory))) {
      const relative = NodePath.join(directory, entry, "package.json");
      if (NodeFS.existsSync(NodePath.join(root, relative))) manifests.push(relative);
    }
  }
  const mobileManifestPath = NodePath.join(root, "apps/mobile/package.json");
  if (NodeFS.existsSync(mobileManifestPath)) {
    const mobileManifest = JSON.parse(NodeFS.readFileSync(mobileManifestPath, "utf8"));
    expect(mobileManifest.private).toBe(true);
    assertMobileManifestIsLocalOnly(mobileManifest);
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
  const mobile = NodePath.join(root, "apps/mobile");
  if (NodeFS.existsSync(mobile)) assertMobileDirectoryIsRemoteOnly(mobile);
}
