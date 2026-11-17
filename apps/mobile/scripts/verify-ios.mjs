import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const mobile = new URL("../", import.meta.url);
const require = createRequire(new URL("package.json", mobile));
const capacitorRequire = createRequire(require.resolve("@capacitor/cli"));
const plist = capacitorRequire("plist");
const xcode = capacitorRequire("xcode");
const project = xcode.project(
  fileURLToPath(new URL("ios/App/App.xcodeproj/project.pbxproj", mobile)),
);
project.parseSync();
const objects = project.hash.project.objects;
const configurations = Object.values(objects.XCBuildConfiguration).filter(
  (entry) => typeof entry === "object",
);
assert.equal(configurations.length, 4);
for (const configuration of configurations) {
  assert.equal(String(configuration.buildSettings.IPHONEOS_DEPLOYMENT_TARGET), "17.0");
  if (configuration.buildSettings.INFOPLIST_FILE) {
    assert.equal(configuration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER, "dev.doublepi.cox.mobile");
  }
}
console.log("PASS: all four Xcode configurations target iOS 17; app bundle identifiers match.");

const info = plist.parse(readFileSync(new URL("ios/App/App/Info.plist", mobile), "utf8"));
assert.equal(info.NSAppTransportSecurity.NSAllowsArbitraryLoadsInWebContent, true);
assert.notEqual(info.NSAppTransportSecurity.NSAllowsArbitraryLoads, true);
assert.equal(info.CFBundleIdentifier, "$(PRODUCT_BUNDLE_IDENTIFIER)");
assert.equal(info.ITSAppUsesNonExemptEncryption, false);
assert.equal(typeof info.NSFaceIDUsageDescription, "string");
assert.ok(info.NSFaceIDUsageDescription.trim().length > 0);
assert.equal(typeof info.NSCameraUsageDescription, "string");
assert.ok(info.NSCameraUsageDescription.trim().length > 0);
console.log(
  "PASS: ATS exception is WebContent-only; encryption compliance and privacy strings are set.",
);

const plugins = new URL("ios/App/Plugins/", mobile);
const files = readdirSync(plugins).filter((name) => name.endsWith(".swift"));
const sources = new Map(files.map((name) => [name, readFileSync(new URL(name, plugins), "utf8")]));
const buildSources = Object.values(objects.PBXSourcesBuildPhase)
  .filter((entry) => typeof entry === "object")
  .flatMap((entry) => entry.files.map((file) => (typeof file === "string" ? file : file.value)));
for (const filename of files) {
  const reference = Object.entries(objects.PBXFileReference).find(
    ([, entry]) => typeof entry === "object" && entry.path === filename,
  );
  assert.ok(reference, `Missing Xcode reference for ${filename}`);
  const build = Object.entries(objects.PBXBuildFile).find(
    ([, entry]) => typeof entry === "object" && entry.fileRef === reference[0],
  );
  assert.ok(build && buildSources.includes(build[0]), `Missing Sources membership for ${filename}`);
  const pureLines = sources
    .get(filename)
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("//")).length;
  assert.ok(pureLines <= 250, `${filename} exceeds 250 source lines`);
  console.log(`PASS: ${filename} is in the Sources build phase (${pureLines} source lines).`);
}

const plugin = sources.get("CoxWorkspaceWebViewPlugin.swift");
const session = sources.get("WorkspaceSession.swift");
const bridge = sources.get("WorkspaceShellBridge.swift");
const policy = sources.get("WorkspacePolicy.swift");
assert.match(plugin, /WKWebsiteDataStore\(forIdentifier: profile\.id\)/);
assert.doesNotMatch([...sources.values()].join("\n"), /WKWebsiteDataStore\.default/);
assert.match(plugin, /didReceiveMemoryWarningNotification/);
assert.match(plugin, /while self\.recent\.count >= 2/);
assert.ok(
  plugin.indexOf("while self.recent.count >= 2") <
    plugin.indexOf("let configuration = WKWebViewConfiguration()"),
);
const forget = plugin.slice(plugin.indexOf("@objc public func forgetProfile"));
assert.ok(
  forget.indexOf("self.dispose(id)") <
    forget.indexOf("WKWebsiteDataStore.remove(forIdentifier: id)"),
);
assert.ok(
  forget.indexOf("WKWebsiteDataStore.remove(forIdentifier: id)") < forget.indexOf("call.resolve()"),
);
assert.match(forget, /preparing\.removeValue/);
assert.match(plugin, /url-filter.*\^http:/);
console.log(
  "PASS: UUID store isolation, two-slot pool, memory eviction, transport rules, and ordered removal.",
);

assert.match(session, /WKWebView\(frame: \.zero, configuration: configuration\)/);
assert.doesNotMatch(session + bridge + plugin, /CAPBridgeViewController/);
assert.match(session, /removeScriptMessageHandler\(forName: "coxMobileShell"\)/);
assert.match(session, /currentNavigation/);
assert.match(session, /SecRandomCopyBytes\(kSecRandomDefault, bytes\.count, &bytes\)/);
assert.match(session, /repeating: 0, count: 32/);
assert.match(policy, /bridgeToken = nil/);
assert.match(policy, /gatewayHandoff/);
assert.match(bridge, /forMainFrameOnly: true/);
assert.match(bridge, /message\.frameInfo\.isMainFrame/);
assert.match(bridge, /message\.frameInfo\.securityOrigin/);
assert.match(bridge, /policy\.acceptsToken\(token\)/);
assert.match(policy, /difference \|=/);
assert.match(bridge, /16 \* 1024 \* 1024/);
assert.match(bridge, /workspace\.security_refusal/);
console.log(
  "PASS: plain workspace WebView, gateway revocation, 256-bit tokens, origin/frame/token checks, bounded blob export.",
);

assert.match(sources.get("WorkspaceExports.swift"), /WKDownloadDelegate/);
assert.match(
  sources.get("WorkspaceExports.swift"),
  /UIDocumentPickerViewController\(forExporting:/,
);
assert.match(sources.get("WorkspaceViewController.swift"), /UIPanGestureRecognizer/);
assert.match(
  sources.get("CoxLauncherViewController.swift"),
  /registerPluginInstance\(CoxWorkspaceWebViewPlugin\(\)\)/,
);
console.log(
  "PASS: native recovery pill, document export, and launcher-only Capacitor registration.",
);
console.log(
  "LIMIT: Linux structural verification does not compile UIKit/WebKit or execute an iOS device.",
);
