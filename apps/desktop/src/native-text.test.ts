import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import type { DesktopBackendUpdateState } from "@t3tools/contracts";
import { desktopText, desktopUpdateNotice } from "./native-text.ts";

const state: DesktopBackendUpdateState = {
  desktopVersion: "0.2.3",
  bundledVersion: "0.1.41",
  currentVersion: "0.1.41",
  latestVersion: "0.1.42",
  status: "available",
  message: null,
};

describe("native desktop language and update messages", () => {
  it.each(["zh-CN", "zh-TW", "zh-Hans", "zh_HK", "ZH-cn"])(
    "uses only Chinese copy for %s",
    (locale) => {
      expect(desktopText(locale, "Download")).toBe("下载");
      expect(desktopText(locale, "Cox update")).toBe("Cox 更新");
      expect(desktopText(locale, "Cox {version} is available.", { version: "0.1.42" })).toBe(
        "发现新版 Cox 0.1.42。",
      );
    },
  );

  it.each(["en-US", "en-GB", "de-DE", "ja-JP", ""])(
    "uses only English fallback copy for %s",
    (locale) => {
      expect(desktopText(locale, "Download")).toBe("Download");
      expect(desktopText(locale, "Cox update")).toBe("Cox update");
      expect(desktopText(locale, "Cox {version} is available.", { version: "0.1.42" })).toBe(
        "Cox 0.1.42 is available.",
      );
    },
  );

  it.each(["available", "checking", "installing", "ready", "error", "incompatible"] as const)(
    "never calls the %s state up to date",
    (status) => {
      expect(desktopUpdateNotice("en-US", { ...state, status }).message).not.toContain(
        "up to date",
      );
      expect(desktopUpdateNotice("zh-CN", { ...state, status }).message).not.toContain(
        "已是最新版本",
      );
    },
  );

  it("confirms that a completed download waits for the next launch", () => {
    const english = desktopUpdateNotice("en-US", { ...state, status: "ready" });
    const chinese = desktopUpdateNotice("zh-CN", { ...state, status: "ready" });
    expect(english.message).toContain("next time you open Cox");
    expect(english.message).not.toMatch(/[\u3400-\u9fff]/);
    expect(chinese.message).toContain("下次启动 Cox 时生效");
    expect(chinese.message).not.toContain("Update downloaded");
  });

  it("distinguishes unknown update information from a verified current version", () => {
    expect(
      desktopUpdateNotice("en-US", { ...state, status: "idle", latestVersion: null }).message,
    ).toBe("No update information is available yet.");
    expect(
      desktopUpdateNotice("en-US", {
        ...state,
        status: "idle",
        latestVersion: state.currentVersion,
      }).message,
    ).toBe("Cox is up to date.");
  });

  it("translates known failure messages and retains technical diagnostics", () => {
    expect(
      desktopUpdateNotice("zh-CN", {
        ...state,
        status: "error",
        message: "Update checks are disabled in offline mode.",
      }),
    ).toEqual({ type: "warning", message: "离线模式下无法检查更新。" });
    expect(
      desktopUpdateNotice("zh-CN", { ...state, status: "error", message: "Error: ECONNRESET" }),
    ).toEqual({ type: "warning", message: "Cox 更新失败。\n\nError: ECONNRESET" });
  });

  it("keeps bilingual literals out of native dialogs and selects the OS language", () => {
    const main = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(main).not.toMatch(/[\u3400-\u9fff]/);
    expect(main).toContain("app.getPreferredSystemLanguages()[0]");
    expect(main).toContain('text("Quit Cox")');
    expect(main).toContain('text("Cox permission")');
    expect(main).toContain('text("Cox startup")');
    expect(main).toContain('text("Check for Cox Updates")');
  });
});
