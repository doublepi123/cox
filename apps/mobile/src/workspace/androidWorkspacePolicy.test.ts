import { describe, expect, it } from "vite-plus/test";
import {
  androidDownloadHop,
  androidProfileName,
  androidTransportAllowed,
  AndroidNavigationPolicy,
  AndroidWorkspacePoolPolicy,
} from "./androidWorkspacePolicy";

const identity = {
  profileId: "f0407592-d23a-4e46-8f02-b7050b8c3299",
  origin: "https://host:3773",
  allowInsecureHttp: false,
};
const token = "a".repeat(64);
const nextToken = "b".repeat(64);

describe("Android isolated workspace policy", () => {
  it("partitions cookies by profile UUID and canonical origin including port", async () => {
    const names = await Promise.all([
      androidProfileName(identity),
      androidProfileName({ ...identity, origin: "https://host:3774" }),
      androidProfileName({ ...identity, profileId: "f0407592-d23a-4e46-8f02-b7050b8c3298" }),
    ]);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^cox_srv_[0-9a-f]{32}_[0-9a-f]{64}$/);
    expect(await androidProfileName({ ...identity, origin: "https://HOST:443/" })).toBe(
      await androidProfileName({ ...identity, origin: "https://host" }),
    );
  });

  it.each(["bad-id", "../../Default"])("rejects invalid profile identity %s", async (profileId) => {
    await expect(androidProfileName({ ...identity, profileId })).rejects.toThrow();
  });

  it("fails closed before allocating any pool slot without MULTI_PROFILE", () => {
    const pool = new AndroidWorkspacePoolPolicy();
    expect(pool.open("a", false)).toEqual({ kind: "isolationPanel" });
    pool.open("b", true);
    expect(pool.open("c", true)).toEqual({ kind: "workspace", evicted: null, path: "/" });
  });

  it("evicts the least recently used workspace while retaining each thread path", () => {
    const pool = new AndroidWorkspacePoolPolicy();
    pool.open("a", true);
    pool.remember("a", "/threads/alpha");
    pool.open("b", true);
    pool.remember("b", "/threads/beta");
    pool.open("a", true);
    expect(pool.open("c", true)).toEqual({ kind: "workspace", evicted: "b", path: "/" });
    expect(pool.open("b", true)).toEqual({
      kind: "workspace",
      evicted: "a",
      path: "/threads/beta",
    });
    expect(pool.open("a", true)).toEqual({
      kind: "workspace",
      evicted: "c",
      path: "/threads/alpha",
    });
  });

  it("destroys a live workspace before profile deletion and refuses stale reopen", () => {
    const pool = new AndroidWorkspacePoolPolicy();
    pool.open("a", true);
    expect(pool.forget("a")).toEqual(["destroyWebView", "deleteProfile"]);
    expect(pool.open("a", true)).toEqual({ kind: "isolationPanel" });
    expect(pool.forget("never-opened")).toEqual(["deleteProfile"]);
  });

  it.each([
    ["https://host:3773/x", false, true],
    ["http://host:3773/x", false, false],
    ["file:///secret", true, false],
    ["content://secret", true, false],
    ["https://user:secret@host/", false, false],
  ])("guards transport %s", (url, allowInsecureHttp, allowed) => {
    expect(androidTransportAllowed({ ...identity, allowInsecureHttp }, url)).toBe(allowed);
  });

  it("permits explicitly opted-in HTTP but never an HTTPS profile downgrade", () => {
    expect(
      androidTransportAllowed(
        { ...identity, origin: "http://host:3773", allowInsecureHttp: true },
        "http://host:3773",
      ),
    ).toBe(true);
    expect(
      androidTransportAllowed({ ...identity, allowInsecureHttp: true }, "http://host:3773"),
    ).toBe(false);
  });

  it("strips cookies irreversibly when a redirect leaves the exact origin", () => {
    const initial = { url: `${identity.origin}/download`, cookiesAllowed: true };
    expect(androidDownloadHop(identity, initial, "/file")).toEqual({
      url: `${identity.origin}/file`,
      cookiesAllowed: true,
    });
    const foreign = androidDownloadHop(identity, initial, "https://host:3774/file");
    expect(foreign).toEqual({ url: "https://host:3774/file", cookiesAllowed: false });
    if (!foreign) throw new Error("Expected redirect");
    expect(androidDownloadHop(identity, foreign, `${identity.origin}/back`)?.cookiesAllowed).toBe(
      false,
    );
    expect(androidDownloadHop(identity, initial, "http://host:3773/file")).toBeNull();
  });

  it("opens foreign links externally and blocks non-web navigation", () => {
    const navigation = new AndroidNavigationPolicy(identity);
    expect(navigation.route(`${identity.origin}/threads/a`)).toBe("load");
    expect(navigation.route("https://host:3774/")).toBe("external");
    expect(navigation.route("javascript:alert(1)")).toBe("block");
  });

  it("rejects iframe, foreign-origin and stale tokens across navigation commits", () => {
    const navigation = new AndroidNavigationPolicy(identity);
    const url = `${identity.origin}/threads/a`;
    navigation.start(url);
    expect(navigation.commit(url, token)).toBe(true);
    expect(navigation.accepts({ origin: identity.origin, mainFrame: true, token })).toBe(true);
    expect(navigation.accepts({ origin: identity.origin, mainFrame: false, token })).toBe(false);
    expect(navigation.accepts({ origin: "https://host:3774", mainFrame: true, token })).toBe(false);
    navigation.start(url);
    expect(navigation.accepts({ origin: identity.origin, mainFrame: true, token })).toBe(false);
    expect(navigation.commit(url, nextToken)).toBe(true);
    expect(navigation.accepts({ origin: identity.origin, mainFrame: true, token })).toBe(false);
  });

  it("quarantines gateway return until its exact blank ticket starts and finishes", () => {
    const navigation = new AndroidNavigationPolicy(identity, true);
    const idp = "https://login.example/login";
    expect(navigation.route(idp)).toBe("load");
    navigation.start(idp);
    expect(navigation.commit(idp, token)).toBe(false);
    const target = `${identity.origin}/threads/a`;
    const blank = navigation.start(target);
    expect(blank).toBe("about:blank?cox-gateway=1");
    if (!blank) throw new Error("Expected gateway ticket");
    expect(navigation.finishBarrier(blank)).toBeNull();
    expect(navigation.commit(target, token)).toBe(false);
    navigation.start(blank);
    expect(navigation.finishBarrier("about:blank?cox-gateway=2")).toBeNull();
    expect(navigation.finishBarrier(blank)).toBe(target);
    expect(navigation.finishBarrier(blank)).toBeNull();
    navigation.start(target);
    expect(navigation.commit(target, nextToken)).toBe(true);
    expect(navigation.route(idp)).toBe("external");
  });

  it("does not consume the handoff before the initial gateway redirect occurs", () => {
    const navigation = new AndroidNavigationPolicy(identity, true);
    const target = `${identity.origin}/threads/a`;
    expect(navigation.start(target)).toBeNull();
    navigation.start("https://login.example/login");
    expect(navigation.start(target)).toBe("about:blank?cox-gateway=1");
  });

  it("allows an already authenticated gateway session to commit directly", () => {
    const navigation = new AndroidNavigationPolicy(identity, true);
    const target = `${identity.origin}/threads/a`;
    navigation.start(target);
    expect(navigation.commit(target, token)).toBe(true);
    expect(navigation.route("https://login.example/login")).toBe("external");
  });
});
