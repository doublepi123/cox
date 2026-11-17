// @effect-diagnostics nodeBuiltinImport:off - This source-level test reads a native Swift fixture.
import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import {
  activateWorkspace,
  authorizeWorkspaceMessage,
  commitWorkspace,
  forgetWorkspace,
  initialWorkspaceState,
  navigateWorkspace,
  profileDataStoreId,
  trimWorkspaceMemory,
  workspaceProfile,
} from "./iosWorkspacePolicy";

const profile = workspaceProfile({
  profileId: "aabbccdd-0000-4000-8000-000000000001",
  origin: "https://host:3773",
  allowInsecureHttp: false,
  lastThreadPath: null,
  label: "Workstation",
  serverCount: 3,
});
const second = "aabbccdd-0000-4000-8000-000000000002";
const third = "aabbccdd-0000-4000-8000-000000000003";
const token = "a".repeat(64);
const ready = commitWorkspace(profile, initialWorkspaceState, {
  url: profile.origin,
  generation: 0,
  freshToken: token,
});

describe("iOS launcher wiring", () => {
  it("boots the launcher controller for the active scene", () => {
    const sceneDelegate = readFileSync(
      new URL("../../ios/App/App/SceneDelegate.swift", import.meta.url),
      "utf8",
    );
    expect(sceneDelegate).toContain("window?.rootViewController = CoxLauncherViewController()");
    expect(sceneDelegate).not.toContain("CAPBridgeViewController()");
  });
});

describe("iOS profile isolation", () => {
  it("keeps different-port profiles in different persistent data stores", () => {
    const other = workspaceProfile({ ...profile, profileId: second, origin: "https://host:3774" });
    expect([profileDataStoreId(profile.profileId), profileDataStoreId(other.profileId)]).toEqual([
      "aabbccdd-0000-4000-8000-000000000001",
      "aabbccdd-0000-4000-8000-000000000002",
    ]);
  });
  it.each(["", "../default", "00000000-0000-0000-0000-000000000000"])(
    "fails closed for invalid profile identifier %s",
    (id) => expect(() => profileDataStoreId(id)).toThrow("profile_id"),
  );
  it("evicts the least recently used workspace beyond two slots", () => {
    const pool = { active: second, recent: [profile.profileId, second] };
    const touched = activateWorkspace(pool, profile.profileId);
    expect(activateWorkspace(touched.pool, third)).toEqual({
      pool: { active: third, recent: [profile.profileId, third] },
      dispose: [second],
    });
  });
  it("disposes inactive views immediately on memory pressure", () => {
    expect(trimWorkspaceMemory({ active: second, recent: [profile.profileId, second] })).toEqual({
      pool: { active: second, recent: [second] },
      dispose: [profile.profileId],
    });
  });
  it("orders view disposal before persistent store removal", () => {
    expect(
      forgetWorkspace({ active: second, recent: [profile.profileId, second] }, second),
    ).toEqual({
      pool: { active: null, recent: [profile.profileId] },
      effects: [
        { type: "dispose", profileId: second },
        { type: "removeDataStore", profileId: second },
      ],
    });
  });
});

describe("iOS navigation barrier", () => {
  it.each([
    ["https://host:3773/thread/1", false, "allow"],
    ["https://host:3774", false, "external"],
    ["https://evil.example", false, "external"],
    ["https://host:3773", true, "external"],
    ["http://host:3773", false, "refuse"],
    ["javascript:alert(1)", false, "refuse"],
    ["https://user:secret@host:3773", false, "refuse"],
  ] as const)("routes %s with newWindow=%s to %s", (url, newWindow, action) => {
    expect(navigateWorkspace(profile, ready, { url, isMainFrame: true, newWindow }).action).toBe(
      action,
    );
  });
  it("allows cleartext only for an explicitly opted-in profile", () => {
    const insecure = workspaceProfile({
      ...profile,
      origin: "http://host:3773",
      allowInsecureHttp: true,
    });
    expect(
      navigateWorkspace(insecure, ready, {
        url: insecure.origin,
        isMainFrame: true,
        newWindow: false,
      }).action,
    ).toBe("allow");
  });
  it("revokes reload tokens and binds a fresh token only at commit", () => {
    const next = navigateWorkspace(profile, ready, {
      url: profile.origin,
      isMainFrame: true,
      newWindow: false,
    }).state;
    expect(next.bridgeToken).toBeNull();
    expect(
      commitWorkspace(profile, next, {
        url: profile.origin,
        generation: next.generation,
        freshToken: "b".repeat(64),
      }).bridgeToken,
    ).toBe("b".repeat(64));
  });
  it.each(["https://team.cloudflareaccess.com/login", `${profile.origin}/cdn-cgi/access/login`])(
    "keeps the bridge detached through gateway and foreign IdP navigation from %s",
    (challenge) => {
      const gateway = navigateWorkspace(profile, ready, {
        url: challenge,
        isMainFrame: true,
        newWindow: false,
      }).state;
      expect(gateway.phase).toBe("gateway_handoff");
      const idp = navigateWorkspace(profile, gateway, {
        url: "https://identity.example/login",
        isMainFrame: true,
        newWindow: false,
      });
      expect(idp.action).toBe("allow");
      expect(
        commitWorkspace(profile, idp.state, {
          url: "https://identity.example/login",
          generation: idp.state.generation,
          freshToken: token,
        }).bridgeToken,
      ).toBeNull();
      const returned = navigateWorkspace(profile, idp.state, {
        url: profile.origin,
        isMainFrame: true,
        newWindow: false,
      }).state;
      expect(
        commitWorkspace(profile, returned, {
          url: profile.origin,
          generation: returned.generation,
          freshToken: "c".repeat(64),
        }),
      ).toEqual({ phase: "ready", generation: returned.generation, bridgeToken: "c".repeat(64) });
    },
  );
  it("rejects a stale commit after a newer navigation starts", () => {
    const next = navigateWorkspace(profile, ready, {
      url: profile.origin,
      isMainFrame: true,
      newWindow: false,
    }).state;
    expect(
      commitWorkspace(profile, next, {
        url: profile.origin,
        generation: 0,
        freshToken: token,
      }).bridgeToken,
    ).toBeNull();
  });
});

describe("iOS restricted message boundary", () => {
  const envelope = {
    isMainFrame: true,
    securityOrigin: profile.origin,
    payload: { type: "openServerSwitcher", bridgeToken: token },
  };
  it.each([
    [{ ...envelope, isMainFrame: false }, "frame"],
    [{ ...envelope, securityOrigin: "https://evil.example" }, "origin"],
    [{ ...envelope, securityOrigin: "https://host:3774" }, "origin"],
    [{ ...envelope, payload: { type: "openServerSwitcher", bridgeToken: "stale" } }, "token"],
    [{ ...envelope, payload: { type: "CoxVault", bridgeToken: token } }, "payload"],
    [{ ...envelope, payload: { type: "hapticSelection" } }, "payload"],
  ] as const)("records a security refusal for an untrusted message", (message, refusal) => {
    expect(authorizeWorkspaceMessage(profile, ready, message)).toEqual({ refusal });
  });
  it("refuses all bridge calls while a gateway handoff is pending", () => {
    expect(authorizeWorkspaceMessage(profile, initialWorkspaceState, envelope)).toEqual({
      refusal: "detached",
    });
  });
  it.each([
    { type: "openServerSwitcher" },
    { type: "openConnectionManager" },
    { type: "hapticSelection" },
    { type: "syncThemeColor", color: "#123456" },
    {
      type: "saveBlobDownload",
      dataUrl: "data:text/plain;base64,aGk=",
      filename: "note.txt",
      mimeType: "text/plain",
    },
  ])("accepts the allowed capability $type from the active main frame", (request) => {
    const payload = { ...request, bridgeToken: token };
    expect(authorizeWorkspaceMessage(profile, ready, { ...envelope, payload })).toEqual({
      message: payload,
    });
  });
  it.each([
    { filename: "../secret.txt", dataUrl: "data:text/plain;base64,aGk=" },
    { filename: "large.bin", dataUrl: `data:;base64,${"A".repeat(22_369_624)}` },
  ])("refuses unsafe blob download $filename", (download) => {
    expect(
      authorizeWorkspaceMessage(profile, ready, {
        ...envelope,
        payload: { type: "saveBlobDownload", bridgeToken: token, mimeType: "", ...download },
      }),
    ).toEqual({ refusal: "payload" });
  });
});
