import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import {
  COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES,
  getMobileShellInfo,
  openMobileConnectionManager,
  openMobileServerSwitcher,
  saveMobileBlobDownload,
  syncMobileThemeColor,
  triggerMobileHapticSelection,
  useIsCompactPhoneViewport,
  useMobileShellInfo,
} from "./mobileShellBridge.ts";

function stubWindow(bridge?: unknown, topFrame = true) {
  const frame = {};
  const target = {
    self: frame,
    top: topFrame ? frame : {},
    __coxMobileShell__: bridge,
  };
  vi.stubGlobal("window", target);
  return target;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mobile shell bridge", () => {
  it("uses the validated top-level bridge and attaches the token to every invocation", () => {
    const postMessage = vi.fn();
    const info = { platform: "ios", activeServerLabel: "Local", serverCount: 1 };
    stubWindow({
      info,
      bridgeToken: "secret-token",
      postMessage,
    });

    expect(getMobileShellInfo()).toEqual(info);
    expect(openMobileServerSwitcher()).toBe(true);
    expect(openMobileConnectionManager()).toBe(true);
    expect(syncMobileThemeColor("#abc")).toBe(true);
    expect(triggerMobileHapticSelection()).toBe(true);
    expect(saveMobileBlobDownload("data:text/plain;base64,YQ==", "file.txt", "text/plain")).toBe(
      true,
    );
    expect(postMessage.mock.calls.map(([payload]) => payload)).toEqual([
      { type: "openServerSwitcher", bridgeToken: "secret-token" },
      { type: "openConnectionManager", bridgeToken: "secret-token" },
      { type: "syncThemeColor", color: "#abc", bridgeToken: "secret-token" },
      { type: "hapticSelection", bridgeToken: "secret-token" },
      {
        type: "saveBlobDownload",
        dataUrl: "data:text/plain;base64,YQ==",
        filename: "file.txt",
        mimeType: "text/plain",
        bridgeToken: "secret-token",
      },
    ]);
  });

  it("is a clean no-op without a native bridge", () => {
    stubWindow();
    expect(getMobileShellInfo()).toBeNull();
    expect(openMobileServerSwitcher()).toBe(false);
    expect(openMobileConnectionManager()).toBe(false);
    expect(syncMobileThemeColor("#fff")).toBe(false);
    expect(triggerMobileHapticSelection()).toBe(false);
    expect(saveMobileBlobDownload("data:text/plain,ok", "ok.txt", "text/plain")).toBe(false);
  });

  it.each([
    { bridgeToken: undefined },
    { bridgeToken: " " },
    { info: { platform: "desktop", activeServerLabel: "Local", serverCount: 1 } },
  ])("rejects a malformed bridge field: %j", (override) => {
    const postMessage = vi.fn();
    stubWindow({
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "token",
      postMessage,
      ...override,
    });
    expect(getMobileShellInfo()).toBeNull();
    expect(openMobileServerSwitcher()).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("refuses malformed bridge shapes and invalid requests", () => {
    const postMessage = vi.fn();
    stubWindow({
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "token",
      postMessage: "not a function",
    });
    expect(openMobileServerSwitcher()).toBe(false);

    stubWindow({
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "token",
      postMessage,
    });
    expect(syncMobileThemeColor("red);background:url(javascript:alert(1))")).toBe(false);
    for (const color of [
      "rgb(1)",
      "hsl(%)",
      "oklch(+)",
      "rgb(1 2 3 4 5)",
      "rgb(1/2 3 .5)",
      "hsl(220/40% 12% .5)",
      "oklch(0.21, 0.03, 264.6)",
      "oklch(0.21/0.03 264.6 .5)",
      "rgb(1/2/3/.5)",
      "rgb(1., 2, 3)",
    ]) {
      expect(syncMobileThemeColor(color)).toBe(false);
    }
    expect(saveMobileBlobDownload("data:text/plain,ok", "../../etc/passwd", "text/plain")).toBe(
      false,
    );
    expect(saveMobileBlobDownload("data:text/plain,ok", "..\\secret.txt", "text/plain")).toBe(
      false,
    );
    expect(saveMobileBlobDownload("data:text/plain;base64,***", "ok.txt", "text/plain")).toBe(
      false,
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not expose the bridge in an iframe", () => {
    const postMessage = vi.fn();
    stubWindow(
      {
        info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
        bridgeToken: "token",
        postMessage,
      },
      false,
    );
    expect(getMobileShellInfo()).toBeNull();
    expect(openMobileServerSwitcher()).toBe(false);
    expect(openMobileConnectionManager()).toBe(false);
    expect(syncMobileThemeColor("#fff")).toBe(false);
    expect(triggerMobileHapticSelection()).toBe(false);
    expect(saveMobileBlobDownload("data:text/plain,ok", "ok.txt", "text/plain")).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("rejects a download over the byte cap before posting", () => {
    const postMessage = vi.fn();
    stubWindow({
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "token",
      postMessage,
    });
    const dataUrl = `data:application/octet-stream;base64,${"A".repeat(Math.ceil((COX_MOBILE_SHELL_MAX_DOWNLOAD_BYTES + 1) / 3) * 4)}`;

    expect(saveMobileBlobDownload(dataUrl, "file.bin", "application/octet-stream")).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "android", activeServerLabel: "Local", serverCount: 1 },
    { platform: "ios", activeServerLabel: "Remote", serverCount: 1 },
    { platform: "ios", activeServerLabel: "Local", serverCount: 2 },
  ])("retains the shell snapshot until a field changes: %j", (changedInfo) => {
    const target = stubWindow({
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "token",
      postMessage: vi.fn(),
    });
    const initial = getMobileShellInfo();
    expect(initial).not.toBeNull();
    expect(getMobileShellInfo()).toBe(initial);
    target.__coxMobileShell__ = {
      info: { platform: "ios", activeServerLabel: "Local", serverCount: 1 },
      bridgeToken: "rotated-token",
      postMessage: vi.fn(),
    };
    expect(getMobileShellInfo()).toBe(initial);
    target.__coxMobileShell__ = {
      info: changedInfo,
      bridgeToken: "rotated-token",
      postMessage: vi.fn(),
    };
    expect(getMobileShellInfo()).toEqual(changedInfo);
    expect(getMobileShellInfo()).not.toBe(initial);
    target.__coxMobileShell__ = undefined;
    expect(getMobileShellInfo()).toBeNull();
  });

  it("renders both hooks without a browser during server rendering", () => {
    vi.stubGlobal("window", undefined);
    function ShellStatus() {
      const info = useMobileShellInfo();
      const compact = useIsCompactPhoneViewport();
      return createElement("output", null, JSON.stringify({ info, compact }));
    }
    expect(renderToString(createElement(ShellStatus))).toBe(
      "<output>{&quot;info&quot;:null,&quot;compact&quot;:false}</output>",
    );
  });
});
